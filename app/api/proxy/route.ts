import type { NextRequest } from "next/server";
import { CLIENT_USER_AGENT } from "@/app/llm/protocols/shared";

function globToRe(pattern: string) {
  const regex = pattern.replace(/[/\\.+?^$|()[\]{}]/g, (char) => `\\${char}`).replace(/\*+/g, ".*");
  return new RegExp(`^${regex}$`, "i");
}

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
  "sec-*",
  "x-forwarded-*",
  "x-stainless-*",
].map(globToRe);

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
].map(globToRe);

async function handleProxy(req: NextRequest): Promise<Response> {
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

  const upstreamHeaders = new Headers();
  req.headers.forEach((value, key) => {
    if (!STRIP_REQ_HEADERS.some((pattern) => pattern.test(key))) {
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
    if (!STRIP_RES_HEADERS.some((pattern) => pattern.test(key))) {
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
