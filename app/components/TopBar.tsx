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
}) {
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line pb-2">
      <h1 className="font-serif text-lg font-bold text-ink">
        世界线收束物语 <span className="text-vermilion">·</span>{" "}
        <span className="text-sm font-normal text-ink-soft">观测者年鉴</span>
      </h1>
      {/* 难度常驻顶栏；模式选择在开局面板 */}
      <select
        className="rounded border border-line bg-white px-1.5 py-0.5 text-xs text-ink"
        value={props.difficulty}
        onChange={(e) => props.onDifficulty(e.target.value as GameSetup["difficulty"])}
      >
        <option value="easy">轻松 · 0.8%</option>
        <option value="standard">标准 · 1.0%</option>
        <option value="hard">残酷 · 1.2%</option>
      </select>
      <span className="ml-auto text-xs text-ink-soft">{props.status}</span>
      {props.busy ? (
        <button
          className="rounded border border-line bg-paper-dim px-2 py-0.5 text-xs text-ink hover:bg-line"
          onClick={props.onStop}
        >
          停止
        </button>
      ) : (
        props.hasEntries && (
          <button
            className="rounded border border-line bg-paper-dim px-2 py-0.5 text-xs text-ink hover:bg-line"
            onClick={props.onRestart}
          >
            重新开始
          </button>
        )
      )}
      <label className="flex items-center gap-1 text-xs text-ink-soft select-none">
        <input
          type="checkbox"
          checked={props.showHidden}
          onChange={(e) => props.onShowHidden(e.target.checked)}
        />
        展示隐藏状态
      </label>
      <button
        className={`rounded border px-2 py-1 text-xs ${
          props.drawerOpen
            ? "border-vermilion text-vermilion"
            : "border-line text-ink-soft hover:text-ink"
        }`}
        onClick={props.onToggleDrawer}
        title="模型设置"
      >
        ⚙ 模型
      </button>
    </header>
  );
}
