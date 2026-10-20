import type { GameSetup } from "../llm/types";

export function TopBar(props: {
  difficulty: GameSetup["difficulty"];
  onDifficulty: (d: GameSetup["difficulty"]) => void;
  status: string;
  busy: boolean;
  onStop: () => void;
  /** 有可对局重置（有条目、被停止或已终局）时，停止按钮变成重新开始 */
  hasEntries: boolean;
  onRestart: () => void;
  showHidden: boolean;
  onShowHidden: (b: boolean) => void;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  gmModelName?: string;
}) {
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
          {props.status && (
            <div className="mr-0.5 flex items-center gap-1.5 rounded-md border border-line bg-card px-2 py-0.5 text-xs text-ink-soft">
              <span
                className={`h-1.5 w-1.5 rounded-full ${props.busy ? "animate-pulse bg-vermilion" : "bg-ink-soft/60"}`}
              />
              <span>{props.status}</span>
            </div>
          )}

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
            <span>隐藏状态</span>
          </button>

          <button
            type="button"
            className={`inline-flex h-7 max-w-44 cursor-pointer items-center gap-1 rounded-md border px-2 text-xs font-medium transition ${
              props.drawerOpen
                ? "border-ink bg-ink text-card"
                : "border-line bg-card text-ink-soft hover:border-ink-soft/40 hover:text-ink"
            }`}
            onClick={props.onToggleDrawer}
            title="模型与端点设置"
          >
            <span className="shrink-0">⚙</span>
            <span className="truncate">{props.gmModelName || "模型"}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
