import OpenAI from "openai";
import type { ChatMessage, LLMConfig, ToolCall } from "./types";

function makeClient(config: LLMConfig): OpenAI {
  return new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    // agent 整个跑在浏览器里，key 由用户自己填、只存用户自己的 localStorage
    dangerouslyAllowBrowser: true,
  });
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

function wrapError(err: unknown): LLMError {
  if (err instanceof LLMError) return err;
  if (err instanceof Error) {
    const status = (err as { status?: number }).status;
    if (err.name === "AbortError") return new LLMError("请求已取消", err);
    if (typeof status === "number") {
      return new LLMError(`LLM 请求失败（HTTP ${status}）：${err.message}`, err);
    }
    return new LLMError(
      `无法连接 LLM 端点：${err.message}。请检查 baseURL 是否可达、中转是否允许浏览器跨域（CORS）。`,
      err,
    );
  }
  return new LLMError(String(err));
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

/** 把内部消息格式序列化为 OpenAI wire format。 */
function toWire(m: ChatMessage): OpenAI.ChatCompletionMessageParam {
  switch (m.role) {
    case "system":
    case "user":
      return { role: m.role, content: m.content };
    case "assistant":
      return {
        role: "assistant",
        content: m.content,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: JSON.stringify(tc.args) },
              })),
            }
          : {}),
      };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
}

function buildParams(
  config: LLMConfig,
  messages: ChatMessage[],
  tools?: ToolSpec[],
): OpenAI.ChatCompletionCreateParamsNonStreaming {
  return {
    model: config.model,
    messages: messages.map(toWire),
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    reasoning_effort: config.reasoningEffort,
    ...(tools?.length
      ? {
          tools: tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }
      : {}),
  };
}

/** 非流式语义的调用（玩家 agent、连接测试用）——底层同样走流式，攒齐后一次性返回。 */
export async function chat(
  config: LLMConfig,
  messages: ChatMessage[],
  opts?: CallOptions & { tools?: ToolSpec[] },
): Promise<{ content: string | null; toolCalls: ToolCall[] }> {
  let content = "";
  let toolCalls: ToolCall[] = [];
  for await (const ev of streamTurn(config, messages, opts)) {
    if (ev.type === "text") content += ev.delta;
    else toolCalls = ev.toolCalls;
  }
  return { content: content || null, toolCalls };
}

export type StreamEvent = { type: "text"; delta: string } | { type: "tool_calls"; toolCalls: ToolCall[] };

/**
 * 流式调用（GM 用）：一次补全里正文与工具调用共存——
 * content delta 实时流出，tool_calls delta 累积到补全结束后一次性给出。
 */
export async function* streamTurn(
  config: LLMConfig,
  messages: ChatMessage[],
  opts?: CallOptions & { tools?: ToolSpec[] },
): AsyncIterable<StreamEvent> {
  try {
    const stream = await makeClient(config).chat.completions.create(
      {
        ...buildParams(config, messages, opts?.tools),
        stream: true,
      },
      { signal: opts?.signal },
    );
    // tool_calls 增量累积：按 index 聚合 id/name/arguments 分片
    const acc = new Map<number, { id: string; name: string; arguments: string }>();
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta;
      if (delta?.content) yield { type: "text", delta: delta.content };
      for (const tc of delta?.tool_calls ?? []) {
        const slot = acc.get(tc.index) ?? { id: "", name: "", arguments: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.arguments += tc.function.arguments;
        acc.set(tc.index, slot);
      }
    }
    if (acc.size > 0) {
      const toolCalls: ToolCall[] = [...acc.values()].map((s, i) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(s.arguments || "{}");
        } catch {
          // 同上：非法 JSON 交给 handler 报错
        }
        return { id: s.id || `call_${i}`, name: s.name, args };
      });
      yield { type: "tool_calls", toolCalls };
    }
  } catch (e) {
    throw wrapError(e);
  }
}
