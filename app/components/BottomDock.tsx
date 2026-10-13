import { InputBar } from "./InputBar";
import type { Mode } from "./entries";

/**
 * 固定底栏：自己玩且等待输入 = 选项 + 自由输入；观战进行中 = 状态文字；
 * 已终局 = 再开一周目。其余情况（未开始/空闲）不渲染。
 */
export function BottomDock(props: {
  mode: Mode;
  busy: boolean;
  gameOver: boolean;
  waitingInput: boolean;
  playerThinking: boolean;
  options: string[];
  onSubmit: (action: string) => void;
  onRestart: () => void;
}) {
  const { mode, busy, gameOver, waitingInput } = props;
  if (!busy && !gameOver) return null;

  let body: React.ReactNode = null;
  if (gameOver) {
    body = (
      <button
        className="rounded bg-vermilion px-4 py-1.5 text-sm font-medium text-paper hover:opacity-90"
        onClick={props.onRestart}
      >
        再开一周目
      </button>
    );
  } else if (mode === "play" && waitingInput) {
    body = <InputBar options={props.options} onSubmit={props.onSubmit} />;
  } else {
    body = (
      <p className="text-xs text-ink-soft">
        {mode === "spectate"
          ? props.playerThinking
            ? "观战中 · 玩家行动中…"
            : "观战中 · 世界线收束中…"
          : "世界线收束中…"}
      </p>
    );
  }

  return (
    <div className="rounded border border-line bg-card p-3 shadow-[0_-2px_12px_rgba(43,38,32,0.06)]">
      {body}
    </div>
  );
}
