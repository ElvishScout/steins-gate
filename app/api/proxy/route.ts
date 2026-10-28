import type { NextRequest } from "next/server";
import { CLIENT_USER_AGENT } from "@/app/llm/protocols/shared";

/** 不应转发给上游 LLM 端点的请求头（浏览器特征头、逐跳头、代理自用头） */
const STRIP_REQ_HEADERS = [
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "origin",
  "referer",
  "cookie",
  "user-agent",
  "x-target-url",
  // 逐跳头：Node fetch 遇到其中部分会直接抛错（invalid ... header），必须剥离
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  // 代理/网络基础设施特征
  "forwarded",
  "via",
  "x-real-ip",
  /^sec-/,
  /^x-forwarded-/,
  /^x-stainless-/,
];

/** Node fetch 会自动解压响应体，必须剥离编码与长度头，避免浏览器二次解压报错 */
const STRIP_RES_HEADERS = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  // 逐跳头
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
  // 上游响应不应改写本站 cookie（且 forEach 对多个 set-cookie 会逐个回调，set 只会保留最后一个）
  "set-cookie",
];

/**
 * 代理只放行 LLM API 的标准端点路径，避免本站被当作可访问任意路径的开放代理。
 * 采用后缀匹配，以兼容 baseURL 自带的前缀（/v1、/api/v1、/v1beta、/v1beta/openai 等）。
 */
const ALLOWED_PATH_PATTERNS = [
  // OpenAI：Chat Completions / Responses / 模型元信息
  /\/chat\/completions$/,
  /\/responses$/,
  /\/models$/,
  /\/models\/[^/:]+$/,
  // Gemini 原生协议：models/{model}:generateContent、:streamGenerateContent 等（方法名含大写字母）
  /\/models\/[^/]+:(?:streamG|g)enerateContent$/,
  /\/models\/[^/]+:countTokens$/,
];

function matchAny(patterns: (string | RegExp)[], text: string, ignoreCase?: boolean) {
  return patterns.some((pattern) => {
    if (typeof pattern === "string") {
      if (ignoreCase) {
        return pattern.toLowerCase() === text.toLowerCase();
      }
      return pattern === text;
    }
    if (ignoreCase) {
      return new RegExp(pattern, "i").test(text);
    }
    return pattern.test(text);
  });
}

/**
 * 同源校验：浏览器跨站请求会带上来源站点的 Origin，直接拒绝，避免本站代理被其它网页盗用。
 * 只比较 host 而非完整 origin：TLS 由反向代理终结时，req.nextUrl 的协议可能与浏览器 Origin 不一致。
 * 不带 Origin 的请求（curl、服务端 SDK）无法通过该机制约束，仍需依赖路径白名单。
 */
function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === req.nextUrl.host.toLowerCase();
  } catch {
    // Origin: null（沙箱 iframe、file:// 等）无法解析，按非同源处理
    return false;
  }
}

async function handleProxy(req: NextRequest): Promise<Response> {
  if (!isSameOrigin(req)) {
    return Response.json({ error: { message: "代理请求必须来自本站同源页面" } }, { status: 403 });
  }

  const rawTarget = req.headers.get("x-target-url")?.trim();
  if (!rawTarget) {
    return Response.json({ error: { message: "代理请求缺少目标地址（x-target-url）" } }, { status: 400 });
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(rawTarget);
  } catch {
    return Response.json({ error: { message: `无效的目标 URL：${rawTarget}` } }, { status: 400 });
  }

  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    return Response.json({ error: { message: `不支持的协议：${targetUrl.protocol}` } }, { status: 400 });
  }

  const normalizedPath = targetUrl.pathname.replace(/\/+$/, "") || "/";
  if (!matchAny(ALLOWED_PATH_PATTERNS, normalizedPath)) {
    return Response.json(
      { error: { message: `代理不允许访问该路径：${targetUrl.pathname}（仅支持 OpenAI / Gemini 兼容 API 端点）` } },
      { status: 403 },
    );
  }

  const upstreamHeaders = new Headers();
  req.headers.forEach((value, key) => {
    if (!matchAny(STRIP_REQ_HEADERS, key, true)) {
      upstreamHeaders.set(key, value);
    }
  });
  upstreamHeaders.set("user-agent", CLIENT_USER_AGENT);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const body = hasBody ? await req.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: req.method,
      headers: upstreamHeaders,
      body: body && body.byteLength > 0 ? body : undefined,
      signal: req.signal,
    });
  } catch (err) {
    if (req.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: { message: `代理无法连接目标端点（${targetUrl.origin}）：${msg}` } },
      { status: 502 },
    );
  }

  const resHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!matchAny(STRIP_RES_HEADERS, key, true)) {
      resHeaders.set(key, value);
    }
  });
  resHeaders.set("Cache-Control", "no-cache, no-transform");
  resHeaders.set("X-Accel-Buffering", "no");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: resHeaders,
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  return handleProxy(req);
}

export async function GET(req: NextRequest): Promise<Response> {
  return handleProxy(req);
}
