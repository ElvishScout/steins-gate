import type OpenAI from "openai";
import type { ChatMessage, LLMConfig } from "../types";
import { makeOpenAIClient } from "./openai-client";
import {
  finalizeToolCalls,
  type CallOptions,
  type StreamEvent,
  type ToolSpec,
} from "./shared";

/** 提取 Gemini OpenAI 兼容层在 tool_call 或 delta 上携带的 thought_signature。 */
function extractThoughtSignature(obj: unknown): string | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const rec = obj as Record<string, unknown>;
  const extra = rec.extra_content as Record<string, unknown> | undefined;
  const google = extra?.google as Record<string, unknown> | undefined;
  if (typeof google?.thought_signature === "string" && google.thought_signature) {
    return google.thought_signature;
  }
  if (typeof rec.thought_signature === "string" && rec.thought_signature) {
    return rec.thought_signature;
  }
  const fn = rec.function as Record<string, unknown> | undefined;
  if (typeof fn?.thought_signature === "string" && fn.thought_signature) {
    return fn.thought_signature;
  }
  return undefined;
}

/** 把内部消息格式序列化为 OpenAI Chat Completions wire format。 */
function toChatWire(m: ChatMessage, config: LLMConfig): OpenAI.ChatCompletionMessageParam {
  switch (m.role) {
    case "system":
    case "user":
      return { role: m.role, content: m.content };
    case "assistant": {
      const hasAnySig = m.toolCalls?.some((tc) => Boolean(tc.thoughtSignature)) ?? false;
      const isGemini =
        /gemini/i.test(config.model) || /generativelanguage\.googleapis\.com/i.test(config.baseURL);
      return {
        role: "assistant",
        content: m.content,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((tc, i) => {
                // Gemini 要求同回合的每次函数调用都带回 thought_signature（并行调用仅首个带签名）；
                // 若中转剥离了响应里的签名，则按 Google 文档回填官方跳过校验哨兵值。
                const sig =
                  tc.thoughtSignature ??
                  (!hasAnySig && isGemini && i === 0
                    ? "skip_thought_signature_validator"
                    : undefined);
                return {
                  id: tc.id,
                  type: "function" as const,
                  function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                  ...(sig ? { extra_content: { google: { thought_signature: sig } } } : {}),
                };
              }),
            }
          : {}),
      };
    }
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
    messages: messages.map((m) => toChatWire(m, config)),
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

export async function* streamChatCompletions(
  config: LLMConfig,
  messages: ChatMessage[],
  opts?: CallOptions & { tools?: ToolSpec[] },
): AsyncIterable<StreamEvent> {
  const client = makeOpenAIClient(config);
  const stream = await client.chat.completions.create(
    {
      ...buildChatParams(config, messages, opts?.tools),
      stream: true,
    },
    { signal: opts?.signal },
  );
  // tool_calls 增量累积：按 index 聚合 id/name/arguments/thoughtSignature 分片
  const acc = new Map<
    number,
    { id: string; name: string; arguments: string; thoughtSignature?: string }
  >();
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
    for (const [i, tc] of (delta?.tool_calls ?? []).entries()) {
      const idx = typeof tc.index === "number" ? tc.index : i;
      const slot = acc.get(idx) ?? { id: "", name: "", arguments: "" };
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (tc.function?.arguments) slot.arguments += tc.function.arguments;
      const sig =
        extractThoughtSignature(tc) ?? (idx === 0 ? extractThoughtSignature(delta) : undefined);
      if (sig && !slot.thoughtSignature) slot.thoughtSignature = sig;
      acc.set(idx, slot);
    }
  }
  if (acc.size > 0) {
    yield { type: "tool_calls", toolCalls: finalizeToolCalls(acc.values()) };
  }
}
