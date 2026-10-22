import type { LLMConfig, LLMProtocol } from "../llm/types";

export interface ProviderConfig {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  protocol: LLMProtocol;
  useProxy?: boolean;
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

const SETTINGS_STORAGE_KEY = "sg:settings:v2";

export function createEmptyProvider(index = 1): ProviderConfig {
  return {
    id: `prov_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: `提供商 ${index}`,
    baseURL: "",
    apiKey: "",
    protocol: "openai-chat",
    models: [""],
  };
}

export function createDefaultSettingsState(): ModelSettingsState {
  const p: ProviderConfig = {
    id: "prov_default",
    name: "默认提供商",
    baseURL: "",
    apiKey: "",
    protocol: "openai-chat",
    models: [""],
  };
  return {
    providers: [p],
    gm: { providerId: p.id, model: "" },
    player: { providerId: p.id, model: "" },
  };
}

/** 将角色指派与提供商配置解析为引擎可直接使用的 LLMConfig */
export function resolveRoleConfig(
  state: ModelSettingsState,
  role: "gm" | "player",
): LLMConfig | null {
  const assign = state[role];
  const provider = state.providers.find((p) => p.id === assign.providerId);
  if (!provider) return null;

  const trimmedModels = provider.models.map((m) => m.trim()).filter(Boolean);
  const targetModel = assign.model.trim();
  const model = targetModel && trimmedModels.includes(targetModel) ? targetModel : (trimmedModels[0] ?? "");

  return {
    baseURL: provider.baseURL.trim(),
    apiKey: provider.apiKey.trim(),
    model,
    reasoningEffort: assign.reasoningEffort,
    protocol: provider.protocol,
    useProxy: provider.useProxy,
  };
}

/** 从 localStorage 读取多提供商设置 */
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
  return createDefaultSettingsState();
}

export function saveModelSettings(state: ModelSettingsState): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}
