import { streamGemini } from "./protocols/gemini";
import { streamChatCompletions } from "./protocols/openai-chat";
import { streamResponses } from "./protocols/openai-responses";
import {
  LLMError,
  isOpenCodeEndpoint,
  wrapError,
  type CallOptions,
  type StreamEvent,
  type ToolSpec,
} from "./protocols/shared";
import type { ChatMessage, LLMConfig, ToolCall } from "./types";

export { LLMError };
export type { CallOptions, StreamEvent, ToolSpec };

/** 非流式语义的调用（玩家 agent、连接测试用）——底层同样走流式，攒齐后一次性返回。 */
export async function chat(
  config: LLMConfig,
  messages: ChatMessage[],
  opts?: CallOptions & { tools?: ToolSpec[] },
): Promise<{ content: string | null; toolCalls: ToolCall[]; reasoning: string }> {
  let content = "";
  let reasoning = "";
  let toolCalls: ToolCall[] = [];
  const sessionId = opts?.sessionId ?? crypto.randomUUID();
  for await (const ev of streamTurn(config, messages, { ...opts, sessionId })) {
    if (ev.type === "text") content += ev.delta;
    else if (ev.type === "reasoning") reasoning += ev.delta;
    else if (ev.type === "tool_calls") toolCalls = ev.toolCalls;
  }
  return { content: content || null, toolCalls, reasoning };
}

/**
 * 流式调用：按 config.protocol 选择适配器。所有协议共享同一套
 * 内部消息格式（ChatMessage/ToolCall）、流式事件（StreamEvent）、
 * 代理 fetch 与工具调用收敛逻辑，适配器只负责 wire format 的来回转换。
 */
export async function* streamTurn(
  config: LLMConfig,
  messages: ChatMessage[],
  opts?: CallOptions & { tools?: ToolSpec[] },
): AsyncIterable<StreamEvent> {
  try {
    if (isOpenCodeEndpoint(config.baseURL) && !config.useProxy) {
      throw new LLMError("使用 OpenCode 端点时需勾选「使用 API 代理」");
    }
    switch (config.protocol) {
      case "gemini":
        yield* streamGemini(config, messages, opts);
        break;
      case "openai-responses":
        yield* streamResponses(config, messages, opts);
        break;
      case "openai-chat":
        yield* streamChatCompletions(config, messages, opts);
        break;
      default:
        throw new LLMError(`不支持的协议：${String(config.protocol)}`);
    }
  } catch (e) {
    throw wrapError(e);
  }
}
