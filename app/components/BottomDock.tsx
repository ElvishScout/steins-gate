import { InputBar } from "./InputBar";
import type { Mode } from "./entries";

/**
 * 底部操作坞（跟随整页流粘性悬浮在视口底部，打印时自动隐藏）：
 * 自己玩且等待输入 = 选项 + 自由输入；观战进行中 = 状态文字；
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
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-ink-soft">本次世界线观测已抵达终局。</span>
        <button
          type="button"
          className="cursor-pointer rounded-lg bg-vermilion px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-vermilion/90 sm:text-sm"
          onClick={props.onRestart}
        >
          再开一周目
        </button>
      </div>
    );
  } else if (mode === "play" && waitingInput) {
    body = <InputBar options={props.options} onSubmit={props.onSubmit} />;
  } else {
    body = (
      <div className="flex items-center gap-2 text-xs text-ink-soft">
        <span className="h-1.5 w-1.5 animate-ping rounded-full bg-vermilion" />
        <span>
          {mode === "spectate"
            ? props.playerThinking
              ? "观战中 · 玩家行动中…"
              : "观战中 · 世界线收束中…"
            : "世界线收束中…"}
        </span>
      </div>
    );
  }

  return (
    <div className="sticky bottom-2 z-20 rounded-xl border border-line bg-card/95 p-2.5 shadow-[0_4px_20px_rgba(24,24,27,0.08)] backdrop-blur-md print:hidden">
      {body}
    </div>
  );
}
