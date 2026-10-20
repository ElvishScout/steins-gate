import type { LLMConfig } from "../llm/types";

export const EMPTY_CONFIG: LLMConfig = { baseURL: "", apiKey: "", model: "" };

export interface ProviderConfig {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  useResponsesApi?: boolean;
  useProxy?: boolean;
  /** 该提供商下的模型名称列表（至少保留一项供输入） */
  models: string[];
}

export interface RoleAssignment {
  providerId: string;
  model: string;
  reasoningEffort?: LLMConfig["reasoningEffort"];
}

export interface ModelSettingsState {
  providers: ProviderConfig[];
  gm: RoleAssignment;
  player: RoleAssignment;
}

const SETTINGS_STORAGE_KEY = "sg:settings:v1";

function guessProviderName(baseURL: string, fallback: string): string {
  const lower = baseURL.toLowerCase();
  if (lower.includes("deepseek")) return "DeepSeek";
  if (lower.includes("openai.com")) return "OpenAI";
  if (lower.includes("googleapis.com") || lower.includes("gemini")) return "Gemini";
  if (lower.includes("openrouter")) return "OpenRouter";
  if (lower.includes("siliconflow")) return "SiliconFlow";
  if (lower.includes("moonshot")) return "Moonshot";
  if (lower.includes("anthropic")) return "Anthropic";
  if (lower.includes("volces.com")) return "火山引擎";
  if (lower.includes("aliyuncs.com") || lower.includes("dashscope")) return "百炼 DashScope";
  try {
    const host = new URL(baseURL).hostname.replace(/^api\./, "");
    if (host) return host;
  } catch {
    /* ignore */
  }
  return fallback;
}

export function createEmptyProvider(index = 1): ProviderConfig {
  return {
    id: `prov_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: `提供商 ${index}`,
    baseURL: "",
    apiKey: "",
    models: [""],
  };
}

export function createDefaultSettingsState(): ModelSettingsState {
  const p: ProviderConfig = {
    id: "prov_default",
    name: "默认提供商",
    baseURL: "",
    apiKey: "",
    models: [""],
  };
  return {
    providers: [p],
    gm: { providerId: p.id, model: "" },
    player: { providerId: p.id, model: "" },
  };
}

/** 将角色指派与提供商配置解析为引擎可直接使用的 LLMConfig */
export function resolveRoleConfig(state: ModelSettingsState, role: "gm" | "player"): LLMConfig {
  const assign = state[role];
  const provider = state.providers.find((p) => p.id === assign.providerId) ?? state.providers[0];
  if (!provider) return EMPTY_CONFIG;

  const trimmedModels = provider.models.map((m) => m.trim()).filter(Boolean);
  const targetModel = assign.model.trim();
  const model = targetModel && trimmedModels.includes(targetModel) ? targetModel : (trimmedModels[0] ?? "");

  return {
    baseURL: provider.baseURL.trim(),
    apiKey: provider.apiKey.trim(),
    model,
    reasoningEffort: assign.reasoningEffort,
    useResponsesApi: provider.useResponsesApi,
    useProxy: provider.useProxy,
  };
}

function readLegacyConfig(key: string): LLMConfig | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LLMConfig>;
    if (parsed && (parsed.baseURL || parsed.apiKey || parsed.model)) {
      return {
        baseURL: parsed.baseURL ?? "",
        apiKey: parsed.apiKey ?? "",
        model: parsed.model ?? "",
        reasoningEffort: parsed.reasoningEffort,
        useResponsesApi: parsed.useResponsesApi,
        useProxy: parsed.useProxy,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 从 localStorage 读取多提供商设置，并自动迁移旧版 sg:gm / sg:player 数据 */
export function loadModelSettings(): ModelSettingsState {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ModelSettingsState;
      if (Array.isArray(parsed?.providers) && parsed.providers.length > 0) {
        return parsed;
      }
    }
  } catch {
    /* ignore */
  }

  const legacyGm = readLegacyConfig("sg:gm");
  const legacyPlayer = readLegacyConfig("sg:player");

  if (!legacyGm && !legacyPlayer) {
    return createDefaultSettingsState();
  }

  const providers: ProviderConfig[] = [];
  const gmSrc = legacyGm ?? legacyPlayer!;
  const p1: ProviderConfig = {
    id: "prov_1",
    name: guessProviderName(gmSrc.baseURL, "提供商 1"),
    baseURL: gmSrc.baseURL,
    apiKey: gmSrc.apiKey,
    useResponsesApi: gmSrc.useResponsesApi,
    useProxy: gmSrc.useProxy,
    models: [gmSrc.model || ""],
  };
  providers.push(p1);

  let playerProviderId = p1.id;
  let playerModel = gmSrc.model || "";

  if (legacyPlayer && (legacyPlayer.baseURL || legacyPlayer.apiKey || legacyPlayer.model)) {
    const sameEndpoint =
      legacyPlayer.baseURL.trim() === p1.baseURL.trim() &&
      legacyPlayer.apiKey.trim() === p1.apiKey.trim() &&
      Boolean(legacyPlayer.useResponsesApi) === Boolean(p1.useResponsesApi) &&
      Boolean(legacyPlayer.useProxy) === Boolean(p1.useProxy);

    if (sameEndpoint) {
      if (legacyPlayer.model && !p1.models.includes(legacyPlayer.model)) {
        p1.models = [...p1.models.filter(Boolean), legacyPlayer.model];
      }
      playerModel = legacyPlayer.model || p1.models[0] || "";
    } else {
      const p2: ProviderConfig = {
        id: "prov_2",
        name: guessProviderName(legacyPlayer.baseURL, "提供商 2"),
        baseURL: legacyPlayer.baseURL,
        apiKey: legacyPlayer.apiKey,
        useResponsesApi: legacyPlayer.useResponsesApi,
        useProxy: legacyPlayer.useProxy,
        models: [legacyPlayer.model || ""],
      };
      providers.push(p2);
      playerProviderId = p2.id;
      playerModel = legacyPlayer.model || "";
    }
  }

  const migrated: ModelSettingsState = {
    providers,
    gm: {
      providerId: p1.id,
      model: gmSrc.model || "",
      reasoningEffort: legacyGm?.reasoningEffort,
    },
    player: {
      providerId: playerProviderId,
      model: playerModel,
      reasoningEffort: legacyPlayer?.reasoningEffort,
    },
  };
  saveModelSettings(migrated);
  return migrated;
}

export function saveModelSettings(state: ModelSettingsState): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}
