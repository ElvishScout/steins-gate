import type { ChatMessage, LLMConfig, ToolCall } from "../types";

/** 客户端标识：符合 OpenCode Go 等网关对独立 Coding Agent User-Agent 的要求 */
export const CLIENT_USER_AGENT = "steins-gate-agent/0.1.0";

export interface CallOptions {
  signal?: AbortSignal;
  /** 稳定的会话 ID（写入 x-opencode-session，用于路由粘性与 Prompt Caching） */
  sessionId?: string;
}

export function isOpenCodeEndpoint(baseURL: string): boolean {
  return /opencode\.ai/i.test(baseURL);
}

/** 构造所有 LLM 请求共用的客户端标识与会话头（x-opencode-session 仅在检测到 opencode 时注入） */
export function buildClientHeaders(config: LLMConfig, sessionId?: string): Record<string, string> {
  return {
    "User-Agent": CLIENT_USER_AGENT,
    ...(isOpenCodeEndpoint(config.baseURL) && sessionId ? { "x-opencode-session": sessionId } : {}),
  };
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  /** 非工具调用的思维链签名（Gemini 原生协议要求后续轮次回传） */
  | { type: "signature"; signature: string }
  | { type: "tool_calls"; toolCalls: ToolCall[] };

export class LLMError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

export function wrapError(err: unknown): LLMError {
  if (err instanceof LLMError) return err;
  if (err instanceof Error) {
    const status = (err as { status?: number }).status;
    if (err.name === "AbortError") return new LLMError("请求已取消", err);
    if (typeof status === "number") {
      return new LLMError(`LLM 请求失败（HTTP ${status}）：${err.message}`, err);
    }
    return new LLMError(
      `无法连接 LLM 端点：${err.message}。请检查 baseURL 是否可达，或开启「使用 API 代理」以规避浏览器跨域（CORS）限制。`,
      err,
    );
  }
  return new LLMError(String(err));
}

/**
 * 所有协议共用的代理 fetch：把原始请求目标塞进 x-target-url，交给 /api/proxy 转发。
 * OpenAI SDK 与 Google GenAI SDK 都接受自定义 fetch，因此 CORS 方案只需维护这一份。
 */
export const proxyFetch: typeof fetch = (input, init) => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const headers = new Headers(init?.headers);
  headers.set("x-target-url", target);
  return fetch("/api/proxy", { ...init, headers });
};

/** 各协议流式增量累积后的工具调用草稿。 */
export interface ToolCallDraft {
  id?: string;
  name: string;
  /** OpenAI 流式分片拼接出的 JSON 字符串 */
  arguments?: string;
  /** Gemini 官方 SDK 直接给出的结构化参数 */
  args?: Record<string, unknown>;
  thoughtSignature?: string;
}

/** 把协议各自的增量合并结果统一成内部 ToolCall。 */
export function finalizeToolCalls(drafts: Iterable<ToolCallDraft>): ToolCall[] {
  return [...drafts].map((d, i) => {
    let args = d.args ?? {};
    if (d.arguments !== undefined) {
      try {
        const parsed = JSON.parse(d.arguments || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        // 非法 JSON 交给 handler 报错
      }
    }
    return {
      id: d.id || `call_${i}`,
      name: d.name,
      args,
      ...(d.thoughtSignature ? { thoughtSignature: d.thoughtSignature } : {}),
    };
  });
}

/** 把内部消息里的系统提示合并成单段（Gemini 等协议只接受一个 system instruction）。 */
export function collectSystem(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "system") parts.push(m.content);
  }
  return parts.join("\n\n");
}
