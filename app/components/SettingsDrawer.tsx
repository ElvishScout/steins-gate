import { useEffect, useRef, useState } from "react";
import type { LLMConfig, LLMProtocol } from "../llm/types";
import {
  createEmptyProvider,
  resolveRoleConfig,
  type ModelSettingsState,
  type ProviderConfig,
  type RoleAssignment,
} from "./ConfigForm";

const PROTOCOL_OPTIONS: { value: LLMProtocol; label: string }[] = [
  { value: "openai-chat", label: "OpenAI · Chat Completions" },
  { value: "openai-responses", label: "OpenAI · Responses API" },
  { value: "gemini", label: "Gemini · Generate Content" },
];

interface ModelOption {
  value: string; // `${providerId}::${model}`
  providerId: string;
  providerName: string;
  model: string;
}

function buildModelOptions(providers: ProviderConfig[]): ModelOption[] {
  const list: ModelOption[] = [];
  for (const p of providers) {
    const models = p.models.map((m) => m.trim()).filter(Boolean);
    for (const m of models) {
      list.push({
        value: `${p.id}::${m}`,
        providerId: p.id,
        providerName: p.name || "未命名提供商",
        model: m,
      });
    }
  }
  return list;
}

function RoleSelectorCard(props: {
  title: string;
  badge: string;
  assignment: RoleAssignment;
  resolved: LLMConfig | null;
  options: ModelOption[];
  onChange: (next: RoleAssignment) => void;
  onTest: () => void;
  testing: boolean;
}) {
  const { title, badge, assignment, resolved, options, onChange } = props;
  const resolvedModel = resolved?.model;
  const currentKey =
    resolvedModel && options.some((o) => o.providerId === assignment.providerId && o.model === resolvedModel)
      ? `${assignment.providerId}::${resolvedModel}`
      : (options[0]?.value ?? "");

  const selectClass =
    "w-full min-w-0 rounded-lg border border-line bg-paper/60 px-3 py-2 text-sm text-ink transition focus:border-vermilion focus:bg-card focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-card p-4 shadow-2xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-ink">{title}</span>
          <span className="rounded bg-paper-dim px-2 py-0.5 font-mono text-xs text-ink-soft">{badge}</span>
        </div>
        <button
          type="button"
          className="shrink-0 cursor-pointer rounded-lg border border-line bg-paper-dim px-3 py-1 text-xs font-medium text-ink transition hover:bg-line/70 disabled:cursor-not-allowed disabled:opacity-40"
          onClick={props.onTest}
          disabled={props.testing || !resolved?.baseURL || !resolved?.apiKey || !resolved?.model}
        >
          {props.testing ? "测试中…" : "测试连接"}
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <select
          className={selectClass}
          value={currentKey}
          disabled={options.length === 0}
          onChange={(e) => {
            const val = e.target.value;
            const sep = val.indexOf("::");
            if (sep > 0) {
              onChange({
                ...assignment,
                providerId: val.slice(0, sep),
                model: val.slice(sep + 2),
              });
            }
          }}
        >
          {options.length === 0 ? (
            <option value="">选择模型</option>
          ) : (
            options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.providerName} / {o.model}
              </option>
            ))
          )}
        </select>

        <select
          className={selectClass}
          value={assignment.reasoningEffort ?? ""}
          onChange={(e) =>
            onChange({
              ...assignment,
              reasoningEffort: (e.target.value || undefined) as LLMConfig["reasoningEffort"],
            })
          }
          title="推理强度 (Reasoning Effort)"
        >
          <option value="">推理强度：默认（不传）</option>
          <option value="none">reasoning effort: none</option>
          <option value="low">reasoning effort: low</option>
          <option value="medium">reasoning effort: medium</option>
          <option value="high">reasoning effort: high</option>
        </select>
      </div>
    </div>
  );
}

/** ⚙ 模型配置 Modal：支持保存多个提供商、每个提供商下保存多个模型，并分别为 GM 与玩家指派 */
export function SettingsDrawer(props: {
  settings: ModelSettingsState;
  onChange: (next: ModelSettingsState) => void;
  onClose: () => void;
  onTest: (c: LLMConfig, which: "gm" | "player") => void;
  testingGm: boolean;
  testingPlayer: boolean;
}) {
  const { settings, onChange, onClose } = props;
  const [activeId, setActiveId] = useState<string>(() => settings.gm.providerId || settings.providers[0]?.id || "");
  const providerItemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const pendingScrollIdRef = useRef<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // 新增提供商后把它滚动到列表可见区域（移动端为横向列表，桌面端为纵向列表）
  useEffect(() => {
    const id = pendingScrollIdRef.current;
    if (!id) return;
    const el = providerItemRefs.current[id];
    if (!el) return;
    pendingScrollIdRef.current = null;
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [settings.providers, activeId]);

  const activeProvider = settings.providers.find((p) => p.id === activeId) ?? settings.providers[0];

  const updateProvider = (patch: Partial<ProviderConfig>) => {
    if (!activeProvider) return;
    const updated = { ...activeProvider, ...patch };
    const nextProviders = settings.providers.map((p) => (p.id === activeProvider.id ? updated : p));
    onChange({ ...settings, providers: nextProviders });
  };

  const addProvider = () => {
    const p = createEmptyProvider(settings.providers.length + 1);
    pendingScrollIdRef.current = p.id;
    onChange({
      ...settings,
      providers: [...settings.providers, p],
    });
    setActiveId(p.id);
  };

  const removeProvider = (id: string) => {
    if (settings.providers.length <= 1) return;
    const nextProviders = settings.providers.filter((p) => p.id !== id);
    const fallback = nextProviders[0];
    const fixAssign = (a: RoleAssignment): RoleAssignment => {
      if (a.providerId !== id) return a;
      const firstModel = fallback.models.map((m) => m.trim()).find(Boolean) ?? "";
      return { ...a, providerId: fallback.id, model: firstModel };
    };
    onChange({
      providers: nextProviders,
      gm: fixAssign(settings.gm),
      player: fixAssign(settings.player),
    });
    if (activeId === id) setActiveId(fallback.id);
  };

  const updateModelAt = (idx: number, val: string) => {
    if (!activeProvider) return;
    const prevModel = activeProvider.models[idx]?.trim() ?? "";
    const nextModels = activeProvider.models.map((m, i) => (i === idx ? val : m));
    const trimmed = val.trim();

    const syncRole = (a: RoleAssignment): RoleAssignment => {
      if (a.providerId !== activeProvider.id) return a;
      if (!a.model || a.model === prevModel) {
        return { ...a, model: trimmed };
      }
      return a;
    };

    onChange({
      providers: settings.providers.map((p) => (p.id === activeProvider.id ? { ...p, models: nextModels } : p)),
      gm: syncRole(settings.gm),
      player: syncRole(settings.player),
    });
  };

  const addModelRow = () => {
    if (!activeProvider) return;
    updateProvider({ models: [...activeProvider.models, ""] });
  };

  const removeModelAt = (idx: number) => {
    if (!activeProvider || activeProvider.models.length <= 1) return;
    const removed = activeProvider.models[idx]?.trim();
    const nextModels = activeProvider.models.filter((_, i) => i !== idx);
    const fallbackModel = nextModels.map((m) => m.trim()).find(Boolean) ?? "";

    const syncRole = (a: RoleAssignment): RoleAssignment => {
      if (a.providerId === activeProvider.id && a.model === removed) {
        return { ...a, model: fallbackModel };
      }
      return a;
    };

    onChange({
      providers: settings.providers.map((p) => (p.id === activeProvider.id ? { ...p, models: nextModels } : p)),
      gm: syncRole(settings.gm),
      player: syncRole(settings.player),
    });
  };

  const options = buildModelOptions(settings.providers);
  const gmResolved = resolveRoleConfig(settings, "gm");
  const playerResolved = resolveRoleConfig(settings, "player");

  const inputClass =
    "w-full min-w-0 rounded-lg border border-line bg-paper/60 px-3 py-2 text-sm text-ink placeholder:text-ink-soft/55 transition focus:border-vermilion focus:bg-card focus:outline-none";

  const activeProtocol = activeProvider.protocol;
  const isGemini = activeProtocol === "gemini";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/45 p-4 backdrop-blur-xs sm:p-6 print:hidden"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-full min-w-0 max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-paper shadow-2xl sm:max-h-[90vh]">
        {/* 顶栏 */}
        <div className="flex items-center justify-between gap-3 border-b border-line bg-card px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex min-w-0 items-center gap-3">
            <h2 className="truncate text-base font-semibold text-ink">⚙ 模型与提供商配置</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 cursor-pointer rounded-lg border border-line bg-paper px-3 py-1 text-xs font-medium whitespace-nowrap text-ink-soft transition hover:bg-paper-dim hover:text-ink"
          >
            ✕ 关闭
          </button>
        </div>

        <div className="flex min-w-0 flex-col gap-5 overflow-y-auto overscroll-none p-4 sm:p-6">
          {/* 角色模型指派区 */}
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <RoleSelectorCard
              title="GM 模型"
              badge="主持 · 必需"
              assignment={settings.gm}
              resolved={gmResolved}
              options={options}
              onChange={(gm) => onChange({ ...settings, gm })}
              onTest={() => {
                if (gmResolved) props.onTest(gmResolved, "gm");
              }}
              testing={props.testingGm}
            />
            <RoleSelectorCard
              title="玩家模型"
              badge="观战模式用"
              assignment={settings.player}
              resolved={playerResolved}
              options={options}
              onChange={(player) => onChange({ ...settings, player })}
              onTest={() => {
                if (playerResolved) props.onTest(playerResolved, "player");
              }}
              testing={props.testingPlayer}
            />
          </div>

          {/* 提供商管理区（左列列表 + 右列详情） */}
          <div className="grid min-w-0 gap-5 rounded-xl border border-line bg-card p-4 shadow-2xs sm:grid-cols-[200px_1fr] sm:p-5">
            {/* 提供商列表 */}
            <div className="flex min-w-0 flex-col gap-2 border-b border-line pb-4 sm:border-r sm:border-b-0 sm:pr-4 sm:pb-0">
              <div className="flex items-center justify-between px-1">
                <span className="text-xs font-semibold text-ink-soft">提供商列表</span>
                <button
                  type="button"
                  onClick={addProvider}
                  className="cursor-pointer rounded-md px-2 py-1 text-xs font-medium text-vermilion transition hover:bg-vermilion/10"
                >
                  + 新增
                </button>
              </div>

              <div className="flex min-w-0 scroll-p-1 flex-row gap-1.5 overflow-x-auto pb-1 sm:flex-col sm:pb-0">
                {settings.providers.map((p) => {
                  const isCurrent = p.id === activeProvider?.id;
                  const modelCount = p.models.filter((m) => m.trim()).length;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      ref={(el) => {
                        providerItemRefs.current[p.id] = el;
                      }}
                      onClick={() => setActiveId(p.id)}
                      className={`flex shrink-0 cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${
                        isCurrent ? "bg-ink font-medium text-card" : "text-ink hover:bg-paper-dim"
                      }`}
                    >
                      <span className="truncate">{p.name || "未命名"}</span>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-xs ${
                          isCurrent ? "bg-card/20 text-card" : "bg-paper-dim text-ink-soft"
                        }`}
                      >
                        {modelCount}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 当前选中提供商表单 */}
            {activeProvider && (
              <div className="flex min-w-0 flex-col gap-3.5">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <label className="mb-1 block text-xs font-medium text-ink-soft">提供商名称</label>
                    <input
                      className={`${inputClass} font-medium`}
                      placeholder="如 OpenAI / Gemini / OpenRouter"
                      value={activeProvider.name}
                      onChange={(e) => updateProvider({ name: e.target.value })}
                    />
                  </div>
                  {settings.providers.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeProvider(activeProvider.id)}
                      className="shrink-0 cursor-pointer rounded-lg border border-line px-3 py-2 text-xs font-medium whitespace-nowrap text-ink-soft transition hover:border-vermilion/40 hover:text-vermilion"
                      title="删除此提供商"
                    >
                      删除提供商
                    </button>
                  )}
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-ink-soft">调用协议</label>
                  <select
                    className={inputClass}
                    value={activeProtocol}
                    onChange={(e) => updateProvider({ protocol: e.target.value as LLMProtocol })}
                  >
                    {PROTOCOL_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                  <div className="min-w-0">
                    <label className="mb-1 block text-xs font-medium text-ink-soft">API 端点 (baseURL)</label>
                    <input
                      className={inputClass}
                      placeholder={
                        isGemini ? "https://generativelanguage.googleapis.com/v1beta" : "https://api.openai.com/v1"
                      }
                      value={activeProvider.baseURL}
                      onChange={(e) => updateProvider({ baseURL: e.target.value })}
                    />
                  </div>

                  <div className="min-w-0">
                    <label className="mb-1 block text-xs font-medium text-ink-soft">API Key</label>
                    <input
                      className={inputClass}
                      type="password"
                      placeholder={isGemini ? "AIza..." : "sk-..."}
                      value={activeProvider.apiKey}
                      onChange={(e) => updateProvider({ apiKey: e.target.value })}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-0.5">
                  <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-ink-soft hover:text-ink select-none">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-vermilion"
                      checked={Boolean(activeProvider.useProxy)}
                      onChange={(e) => updateProvider({ useProxy: e.target.checked || undefined })}
                    />
                    <span>使用 API 代理（解决 CORS）</span>
                  </label>
                </div>

                {/* 该提供商下的模型列表 */}
                <div className="border-t border-line/80 pt-3.5">
                  <div className="mb-2.5 flex items-center justify-between">
                    <span className="text-xs font-semibold text-ink">模型列表</span>
                    <button
                      type="button"
                      onClick={addModelRow}
                      className="cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium text-vermilion transition hover:bg-vermilion/10"
                    >
                      + 添加模型
                    </button>
                  </div>

                  <div className="flex flex-col gap-2">
                    {activeProvider.models.map((m, idx) => {
                      const trimmed = m.trim();
                      const isGm =
                        settings.gm.providerId === activeProvider.id &&
                        gmResolved?.model === trimmed &&
                        Boolean(trimmed);
                      const isPlayer =
                        settings.player.providerId === activeProvider.id &&
                        playerResolved?.model === trimmed &&
                        Boolean(trimmed);

                      return (
                        <div key={idx} className="flex min-w-0 items-center gap-2">
                          <input
                            className={`${inputClass} flex-1`}
                            placeholder={isGemini ? "模型 ID，如 gemini-3-pro-preview" : "模型 ID，如 gpt-4o"}
                            value={m}
                            onChange={(e) => updateModelAt(idx, e.target.value)}
                          />
                          <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                            {trimmed && (
                              <>
                                <button
                                  type="button"
                                  onClick={() =>
                                    onChange({
                                      ...settings,
                                      gm: {
                                        ...settings.gm,
                                        providerId: activeProvider.id,
                                        model: trimmed,
                                      },
                                    })
                                  }
                                  className={`cursor-pointer rounded-lg border px-2.5 py-1.5 font-mono text-xs transition ${
                                    isGm
                                      ? "border-vermilion bg-vermilion/10 font-semibold text-vermilion"
                                      : "border-line bg-paper text-ink-soft hover:text-ink"
                                  }`}
                                  title="设为 GM 模型"
                                >
                                  GM
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    onChange({
                                      ...settings,
                                      player: {
                                        ...settings.player,
                                        providerId: activeProvider.id,
                                        model: trimmed,
                                      },
                                    })
                                  }
                                  className={`cursor-pointer rounded-lg border px-2.5 py-1.5 font-mono text-xs transition ${
                                    isPlayer
                                      ? "border-vermilion bg-vermilion/10 font-semibold text-vermilion"
                                      : "border-line bg-paper text-ink-soft hover:text-ink"
                                  }`}
                                  title="设为玩家模型"
                                >
                                  玩家
                                </button>
                              </>
                            )}
                            {activeProvider.models.length > 1 && (
                              <button
                                type="button"
                                onClick={() => removeModelAt(idx)}
                                className="cursor-pointer rounded-lg px-2 py-1.5 text-xs text-ink-soft hover:bg-paper-dim hover:text-vermilion"
                                title="移除该模型"
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
