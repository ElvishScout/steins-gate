import type OpenAI from "openai";
import type { ChatMessage, LLMConfig } from "../types";
import { makeOpenAIClient } from "./openai-client";
import {
  LLMError,
  finalizeToolCalls,
  type CallOptions,
  type StreamEvent,
  type ToolSpec,
} from "./shared";

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

export async function* streamResponses(
  config: LLMConfig,
  messages: ChatMessage[],
  opts?: CallOptions & { tools?: ToolSpec[] },
): AsyncIterable<StreamEvent> {
  const stream = await makeOpenAIClient(config).responses.create(
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
    yield { type: "tool_calls", toolCalls: finalizeToolCalls(acc.values()) };
  }
}
