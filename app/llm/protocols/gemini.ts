import {
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type GenerateContentConfig,
  type HttpOptions,
  type Part,
  type ThinkingConfig,
} from "@google/genai";
import type { ChatMessage, LLMConfig } from "../types";
import {
  LLMError,
  collectSystem,
  finalizeToolCalls,
  proxyFetch,
  type CallOptions,
  type StreamEvent,
  type ToolSpec,
} from "./shared";

/** 中转丢掉了官方签名时，按 Google 文档回填的跳过校验哨兵值。 */
const SKIP_SIGNATURE = "skip_thought_signature_validator";

/** finalizeToolCalls 为无 id 的调用补的占位 id；回传 Gemini 时不应伪造给服务端。 */
const SYNTHETIC_CALL_ID = /^call_\d+$/;

/**
 * baseURL 与 OpenAI 协议一致，填完整 API 根（如 https://generativelanguage.googleapis.com/v1beta）。
 * apiVersion 置空可让 SDK 原样使用该 URL，不再追加默认的 /v1beta。
 */
function buildHttpOptions(config: LLMConfig): HttpOptions | undefined {
  const options: HttpOptions = {};
  const base = config.baseURL.trim();
  if (base) {
    options.baseUrl = base;
    options.apiVersion = "";
  }
  if (config.useProxy) options.fetch = proxyFetch;
  return Object.keys(options).length > 0 ? options : undefined;
}

function makeClient(config: LLMConfig): GoogleGenAI {
  const httpOptions = buildHttpOptions(config);
  return new GoogleGenAI({
    apiKey: config.apiKey,
    ...(httpOptions ? { httpOptions } : {}),
  });
}

type Effort = NonNullable<LLMConfig["reasoningEffort"]>;

const THINKING_LEVEL: Record<Effort, ThinkingLevel> = {
  none: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/** 推理强度 → thinkingLevel；模型是否支持由 API 自行判定。 */
function buildThinkingConfig(config: LLMConfig): ThinkingConfig {
  const effort = config.reasoningEffort;
  return {
    // 思维链只用于界面展示；none 时不返回思考内容
    includeThoughts: effort !== "none",
    ...(effort ? { thinkingLevel: THINKING_LEVEL[effort] } : {}),
  };
}

/** 解析工具返回值：JSON 对象直接作为 response，其它文本包进 result。 */
function toFunctionResponse(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { result: parsed };
  } catch {
    return { result: content };
  }
}

/**
 * 内部消息 → Gemini contents。系统提示单独走 systemInstruction；
 * 连续的 tool 结果合并进同一个 user turn 的 functionResponse parts。
 */
function toGeminiContents(messages: ChatMessage[]): {
  systemInstruction?: string;
  contents: Content[];
} {
  const systemInstruction = collectSystem(messages) || undefined;
  const contents: Content[] = [];
  // functionResponse 只带 toolCallId，需要从之前的 assistant 调用里找回函数名
  const toolNames = new Map<string, string>();

  for (const m of messages) {
    switch (m.role) {
      case "system":
        break;
      case "user":
        contents.push({ role: "user", parts: [{ text: m.content }] });
        break;
      case "assistant": {
        const parts: Part[] = [];
        if (m.content) {
          parts.push({
            text: m.content,
            ...(m.thoughtSignature ? { thoughtSignature: m.thoughtSignature } : {}),
          });
        }
        const calls = m.toolCalls ?? [];
        const hasAnySignature = calls.some((tc) => Boolean(tc.thoughtSignature));
        calls.forEach((tc, i) => {
          toolNames.set(tc.id, tc.name);
          // 并行调用只有首个带签名；签名全部缺失时回填哨兵值以跳过校验
          const signature =
            tc.thoughtSignature ??
            (!hasAnySignature && i === 0 ? SKIP_SIGNATURE : undefined);
          parts.push({
            functionCall: {
              name: tc.name,
              args: tc.args,
              ...(SYNTHETIC_CALL_ID.test(tc.id) ? {} : { id: tc.id }),
            },
            ...(signature ? { thoughtSignature: signature } : {}),
          });
        });
        if (parts.length > 0) contents.push({ role: "model", parts });
        break;
      }
      case "tool": {
        const part: Part = {
          functionResponse: {
            name: toolNames.get(m.toolCallId) ?? m.toolCallId,
            response: toFunctionResponse(m.content),
            ...(SYNTHETIC_CALL_ID.test(m.toolCallId) ? {} : { id: m.toolCallId }),
          },
        };
        const last = contents[contents.length - 1];
        if (last?.role === "user" && last.parts?.length && last.parts.every((p) => p.functionResponse)) {
          last.parts.push(part);
        } else {
          contents.push({ role: "user", parts: [part] });
        }
        break;
      }
    }
  }

  return { systemInstruction, contents };
}

function buildTools(tools?: ToolSpec[]) {
  if (!tools?.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        // JSON Schema 原样下发，避免 Gemini Schema 的大小写类型转换
        parametersJsonSchema: t.parameters,
      })),
    },
  ];
}

function buildConfig(
  config: LLMConfig,
  systemInstruction: string | undefined,
  tools: ToolSpec[] | undefined,
  signal: AbortSignal | undefined,
): GenerateContentConfig {
  const thinkingConfig = buildThinkingConfig(config);
  const toolDeclarations = buildTools(tools);
  return {
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.maxTokens !== undefined ? { maxOutputTokens: config.maxTokens } : {}),
    thinkingConfig,
    ...(toolDeclarations ? { tools: toolDeclarations } : {}),
    ...(signal ? { abortSignal: signal } : {}),
  };
}

/** 这些 finishReason 意味着模型没有正常产出，直接把原因抛给上层。 */
const BLOCKING_FINISH_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "MALFORMED_FUNCTION_CALL",
  "UNEXPECTED_TOOL_CALL",
  "TOO_MANY_TOOL_CALLS",
]);

interface GeminiCallDraft {
  id?: string;
  name: string;
  args: Record<string, unknown>;
  thoughtSignature?: string;
}

export async function* streamGemini(
  config: LLMConfig,
  messages: ChatMessage[],
  opts?: CallOptions & { tools?: ToolSpec[] },
): AsyncIterable<StreamEvent> {
  const { systemInstruction, contents } = toGeminiContents(messages);
  const stream = await makeClient(config).models.generateContentStream({
    model: config.model,
    contents,
    config: buildConfig(config, systemInstruction, opts?.tools, opts?.signal),
  });

  const calls: GeminiCallDraft[] = [];
  const indexById = new Map<string, number>();

  for await (const chunk of stream) {
    if (chunk.promptFeedback?.blockReason) {
      throw new LLMError(`Gemini 拒绝了请求：${chunk.promptFeedback.blockReason}`);
    }

    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall) {
        const fc = part.functionCall;
        const name = fc.name ?? "";
        let idx = fc.id ? indexById.get(fc.id) : undefined;
        if (idx === undefined) {
          idx = calls.length;
          calls.push({ id: fc.id, name, args: {} });
          if (fc.id) indexById.set(fc.id, idx);
        }
        const slot = calls[idx];
        if (name) slot.name = name;
        if (fc.args) slot.args = { ...slot.args, ...fc.args };
        if (part.thoughtSignature && !slot.thoughtSignature) {
          slot.thoughtSignature = part.thoughtSignature;
        }
        continue;
      }

      if (typeof part.text === "string" && part.text.length > 0) {
        if (part.thought) {
          yield { type: "reasoning", delta: part.text };
        } else {
          if (part.thoughtSignature) {
            yield { type: "signature", signature: part.thoughtSignature };
          }
          yield { type: "text", delta: part.text };
        }
        continue;
      }

      // 流式响应里签名可能作为独立的空 part 落在最后一块
      if (part.thoughtSignature) {
        yield { type: "signature", signature: part.thoughtSignature };
      }
    }

    const finishReason = candidate?.finishReason;
    if (finishReason && BLOCKING_FINISH_REASONS.has(String(finishReason))) {
      throw new LLMError(`Gemini 因 ${finishReason} 停止生成`);
    }
  }

  if (calls.length > 0) {
    yield { type: "tool_calls", toolCalls: finalizeToolCalls(calls) };
  }
}
