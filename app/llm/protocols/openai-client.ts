import OpenAI from "openai";
import type { LLMConfig } from "../types";
import { proxyFetch } from "./shared";

/** OpenAI Chat Completions 与 Responses API 共用同一个客户端配置。 */
export function makeOpenAIClient(config: LLMConfig): OpenAI {
  return new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    // agent 整个跑在浏览器里，key 由用户自己填、只存用户自己的 localStorage
    dangerouslyAllowBrowser: true,
    ...(config.useProxy ? { fetch: proxyFetch } : {}),
  });
}
