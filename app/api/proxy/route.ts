import type { NextRequest } from "next/server";

/** 不应转发给上游 LLM 端点的请求头（浏览器特征头、逐跳头、代理自用头） */
const STRIP_REQ_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "origin",
  "referer",
  "cookie",
  "x-target-url",
]);

function shouldStripReqHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    STRIP_REQ_HEADERS.has(lower) ||
    lower.startsWith("sec-") ||
    lower.startsWith("x-forwarded-") ||
    lower.startsWith("x-stainless-")
  );
}

/** Node fetch 会自动解压响应体，必须剥离编码与长度头，避免浏览器二次解压报错 */
const STRIP_RES_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

async function handleProxy(req: NextRequest): Promise<Response> {
  const rawTarget = req.headers.get("x-target-url") ?? req.nextUrl.searchParams.get("url");
  if (!rawTarget) {
    return Response.json(
      { error: { message: "代理请求缺少目标地址（x-target-url）" } },
      { status: 400 },
    );
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(rawTarget);
  } catch {
    return Response.json(
      { error: { message: `无效的目标 URL：${rawTarget}` } },
      { status: 400 },
    );
  }

  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    return Response.json(
      { error: { message: `不支持的协议：${targetUrl.protocol}` } },
      { status: 400 },
    );
  }

  const upstreamHeaders = new Headers();
  req.headers.forEach((value, key) => {
    if (!shouldStripReqHeader(key)) {
      upstreamHeaders.set(key, value);
    }
  });

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
    if (!STRIP_RES_HEADERS.has(key.toLowerCase())) {
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
