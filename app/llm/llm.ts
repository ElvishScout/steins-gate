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

/** 把内部消息格式序列化为 OpenAI Chat Completions wire format。 */
function toChatWire(m: ChatMessage): OpenAI.ChatCompletionMessageParam {
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

function buildChatParams(
  config: LLMConfig,
  messages: ChatMessage[],
  tools?: ToolSpec[],
): OpenAI.ChatCompletionCreateParamsNonStreaming {
  return {
    model: config.model,
    messages: messages.map(toChatWire),
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

/** 把内部消息格式序列化为 OpenAI Responses API 的 instructions + input items。 */
function toResponsesInput(messages: ChatMessage[]): {
  instructions?: string;
  input: OpenAI.Responses.ResponseInputItem[];
} {
  const systems: string[] = [];
  const input: OpenAI.Responses.ResponseInputItem[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "system":
        systems.push(m.content);
        break;
      case "user":
        input.push({ role: "user", content: m.content });
        break;
      case "assistant":
        if (m.content || !m.toolCalls?.length) {
          input.push({ role: "assistant", content: m.content ?? "" });
        }
        for (const tc of m.toolCalls ?? []) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.args),
          });
        }
        break;
      case "tool":
        input.push({
          type: "function_call_output",
          call_id: m.toolCallId,
          output: m.content,
        });
        break;
    }
  }
  return {
    ...(systems.length ? { instructions: systems.join("\n\n") } : {}),
    input,
  };
}

function buildResponsesParams(
  config: LLMConfig,
  messages: ChatMessage[],
  tools?: ToolSpec[],
): OpenAI.Responses.ResponseCreateParamsStreaming {
  const { instructions, input } = toResponsesInput(messages);
  return {
    model: config.model,
    ...(instructions ? { instructions } : {}),
    input,
    temperature: config.temperature,
    max_output_tokens: config.maxTokens,
    ...(config.reasoningEffort ? { reasoning: { effort: config.reasoningEffort } } : {}),
    ...(tools?.length
      ? {
          tools: tools.map((t) => ({
            type: "function" as const,
            name: t.name,
            description: t.description,
            parameters: t.parameters,
            strict: false,
          })),
        }
      : {}),
    stream: true,
  };
}

function finalizeToolCalls(
  acc: Map<number, { id: string; name: string; arguments: string }>,
): ToolCall[] {
  return [...acc.values()].map((s, i) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(s.arguments || "{}");
    } catch {
      // 非法 JSON 交给 handler 报错
    }
    return { id: s.id || `call_${i}`, name: s.name, args };
  });
}

/** 非流式语义的调用（玩家 agent、连接测试用）——底层同样走流式，攒齐后一次性返回。 */
export async function chat(
  config: LLMConfig,
  messages: ChatMessage[],
  opts?: CallOptions & { tools?: ToolSpec[] },
): Promise<{ content: string | null; toolCalls: ToolCall[]; reasoning: string }> {
  let content = "";
  let reasoning = "";
  let toolCalls: ToolCall[] = [];
  for await (const ev of streamTurn(config, messages, opts)) {
    if (ev.type === "text") content += ev.delta;
    else if (ev.type === "reasoning") reasoning += ev.delta;
    else toolCalls = ev.toolCalls;
  }
  return { content: content || null, toolCalls, reasoning };
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_calls"; toolCalls: ToolCall[] };

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
    if (config.useResponsesApi) {
      yield* streamResponses(config, messages, opts);
    } else {
      yield* streamChatCompletions(config, messages, opts);
    }
  } catch (e) {
    throw wrapError(e);
  }
}

async function* streamChatCompletions(
  config: LLMConfig,
  messages: ChatMessage[],
  opts?: CallOptions & { tools?: ToolSpec[] },
): AsyncIterable<StreamEvent> {
  const stream = await makeClient(config).chat.completions.create(
    {
      ...buildChatParams(config, messages, opts?.tools),
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
    // 思维链：DeepSeek/中转惯例的 reasoning_content（部分端点用 reasoning），SDK 无此类型
    const ext = delta as { reasoning_content?: unknown; reasoning?: unknown } | undefined;
    const r =
      typeof ext?.reasoning_content === "string"
        ? ext.reasoning_content
        : typeof ext?.reasoning === "string"
          ? ext.reasoning
          : "";
    if (r) yield { type: "reasoning", delta: r };
    for (const tc of delta?.tool_calls ?? []) {
      const slot = acc.get(tc.index) ?? { id: "", name: "", arguments: "" };
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (tc.function?.arguments) slot.arguments += tc.function.arguments;
      acc.set(tc.index, slot);
    }
  }
  if (acc.size > 0) {
    yield { type: "tool_calls", toolCalls: finalizeToolCalls(acc) };
  }
}

async function* streamResponses(
  config: LLMConfig,
  messages: ChatMessage[],
  opts?: CallOptions & { tools?: ToolSpec[] },
): AsyncIterable<StreamEvent> {
  const stream = await makeClient(config).responses.create(
    buildResponsesParams(config, messages, opts?.tools),
    { signal: opts?.signal },
  );
  const acc = new Map<number, { id: string; name: string; arguments: string }>();
  let hasText = false;
  for await (const event of stream) {
    switch (event.type) {
      case "response.output_text.delta":
        if (event.delta) {
          hasText = true;
          yield { type: "text", delta: event.delta };
        }
        break;
      case "response.reasoning_text.delta":
      case "response.reasoning_summary_text.delta":
        if (event.delta) yield { type: "reasoning", delta: event.delta };
        break;
      case "response.output_item.added":
        if (event.item.type === "function_call") {
          acc.set(event.output_index, {
            id: event.item.call_id || event.item.id || "",
            name: event.item.name || "",
            arguments: event.item.arguments || "",
          });
        }
        break;
      case "response.function_call_arguments.delta": {
        const slot = acc.get(event.output_index) ?? {
          id: event.item_id || "",
          name: "",
          arguments: "",
        };
        slot.arguments += event.delta;
        acc.set(event.output_index, slot);
        break;
      }
      case "response.function_call_arguments.done": {
        const slot = acc.get(event.output_index);
        if (slot && event.arguments) slot.arguments = event.arguments;
        break;
      }
      case "response.output_item.done":
        if (event.item.type === "function_call") {
          const prev = acc.get(event.output_index);
          acc.set(event.output_index, {
            id: event.item.call_id || event.item.id || prev?.id || "",
            name: event.item.name || prev?.name || "",
            arguments: event.item.arguments || prev?.arguments || "",
          });
        }
        break;
      case "response.completed":
        for (const [i, item] of (event.response.output ?? []).entries()) {
          if (item.type === "function_call" && !acc.has(i)) {
            acc.set(i, {
              id: item.call_id || item.id || "",
              name: item.name,
              arguments: item.arguments,
            });
          } else if (!hasText && item.type === "message") {
            for (const part of item.content ?? []) {
              if (part.type === "output_text" && part.text) {
                yield { type: "text", delta: part.text };
              }
            }
          }
        }
        break;
      case "error":
        throw new LLMError(`LLM 请求失败：${event.message}`);
      case "response.failed":
        throw new LLMError(`LLM 请求失败：${event.response.error?.message ?? "响应失败"}`);
    }
  }
  if (acc.size > 0) {
    yield { type: "tool_calls", toolCalls: finalizeToolCalls(acc) };
  }
}
