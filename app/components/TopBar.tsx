import { useEffect, useRef, useState } from "react";
import type { GameSetup } from "../llm/types";

export function TopBar(props: {
  difficulty: GameSetup["difficulty"];
  onDifficulty: (d: GameSetup["difficulty"]) => void;
  busy: boolean;
  onStop: () => void;
  /** 有可对局重置（有条目、被停止或已终局）时，停止按钮变成重新开始 */
  hasEntries: boolean;
  onRestart: () => void;
  canSave: boolean;
  onSave: (opts: { includeReasoning: boolean; includeTools: boolean }) => void;
  onCopy: (opts: { includeReasoning: boolean; includeTools: boolean }) => Promise<void>;
  showHidden: boolean;
  onShowHidden: (b: boolean) => void;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
}) {
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [includeReasoning, setIncludeReasoning] = useState(false);
  const [includeTools, setIncludeTools] = useState(false);
  const [copied, setCopied] = useState(false);
  const saveMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!saveMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (saveMenuRef.current && !saveMenuRef.current.contains(e.target as Node)) {
        setSaveMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSaveMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [saveMenuOpen]);
  return (
    <header className="sticky top-0 z-30 border-b border-line/80 bg-paper/90 backdrop-blur-md print:static print:bg-transparent">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 py-2 sm:px-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-2 w-2 rounded-full bg-vermilion" />
          <h1 className="font-serif text-base font-bold tracking-tight text-ink sm:text-lg">命运石之门</h1>
          <span className="hidden rounded border border-line bg-card px-1.5 py-0.5 font-mono text-[11px] text-ink-soft sm:inline-block">
            STEINS;GATE · 1.048596%
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 print:hidden">
          <select
            className="h-7 cursor-pointer rounded-md border border-line bg-card px-2 text-xs text-ink transition hover:border-ink-soft/40 focus:border-vermilion focus:outline-none"
            value={props.difficulty}
            onChange={(e) => props.onDifficulty(e.target.value as GameSetup["difficulty"])}
            title="世界线变动壁垒难度"
          >
            <option value="easy">轻松 (0.62~0.78%)</option>
            <option value="standard">标准 (0.38~0.58%)</option>
            <option value="hard">残酷 (0.09~0.34%)</option>
          </select>

          {props.busy ? (
            <button
              className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-vermilion/30 bg-vermilion/10 px-2.5 text-xs font-medium text-vermilion transition hover:bg-vermilion/15"
              onClick={props.onStop}
            >
              <span>■ 停止</span>
            </button>
          ) : (
            props.hasEntries && (
              <button
                className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-line bg-card px-2.5 text-xs font-medium text-ink transition hover:bg-paper-dim"
                onClick={props.onRestart}
              >
                <span>↺ 重新开始</span>
              </button>
            )
          )}

          {props.canSave && (
            <div ref={saveMenuRef} className="relative">
              <button
                type="button"
                className={`inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2.5 text-xs font-medium transition ${
                  saveMenuOpen
                    ? "border-ink bg-ink text-card"
                    : "border-line bg-card text-ink hover:bg-paper-dim"
                }`}
                onClick={() => setSaveMenuOpen((v) => !v)}
                title="保存对话历史为 Markdown 文件"
              >
                <span>↓ 保存</span>
              </button>

              {saveMenuOpen && (
                <div className="absolute right-0 top-full z-40 mt-1.5 w-52 rounded-xl border border-line bg-card p-3 shadow-lg">
                  <div className="mb-2 text-xs font-semibold text-ink">保存对话历史</div>
                  <div className="flex flex-col gap-1.5">
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-ink select-none">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-vermilion"
                        checked={includeReasoning}
                        onChange={(e) => setIncludeReasoning(e.target.checked)}
                      />
                      <span>包含思维链</span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-ink select-none">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-vermilion"
                        checked={includeTools}
                        onChange={(e) => setIncludeTools(e.target.checked)}
                      />
                      <span>包含工具调用</span>
                    </label>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      className="cursor-pointer rounded-lg border border-line bg-paper px-2.5 py-1.5 text-xs font-medium text-ink transition hover:bg-paper-dim"
                      onClick={async () => {
                        await props.onCopy({ includeReasoning, includeTools });
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      }}
                    >
                      {copied ? "✓ 已复制" : "复制内容"}
                    </button>
                    <button
                      type="button"
                      className="cursor-pointer rounded-lg bg-vermilion px-2.5 py-1.5 text-xs font-semibold text-white transition hover:bg-vermilion/90"
                      onClick={() => {
                        props.onSave({ includeReasoning, includeTools });
                        setSaveMenuOpen(false);
                      }}
                    >
                      下载文件
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            role="switch"
            aria-checked={props.showHidden}
            onClick={() => props.onShowHidden(!props.showHidden)}
            className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition select-none ${
              props.showHidden
                ? "border-vermilion/40 bg-vermilion/10 text-vermilion"
                : "border-line bg-card text-ink-soft hover:text-ink"
            }`}
            title="切换是否显示 GM 思维链、工具调用与隐藏世界线状态"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${props.showHidden ? "bg-vermilion" : "bg-line"}`} />
            <span>思维链</span>
          </button>

          <button
            type="button"
            className={`inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2 text-xs font-medium transition ${
              props.drawerOpen
                ? "border-ink bg-ink text-card"
                : "border-line bg-card text-ink-soft hover:border-ink-soft/40 hover:text-ink"
            }`}
            onClick={props.onToggleDrawer}
            title="模型与端点设置"
          >
            <span className="shrink-0">⚙</span>
            <span>模型配置</span>
          </button>
        </div>
      </div>
    </header>
  );
}
