import type { Mode } from "./entries";

/**
 * 开局面板（未开局时占据故事区）：模式、题材（多行）、主角设定 + 开始按钮。
 * 难度在顶栏常驻，不在这里。
 */
export function SetupPanel(props: {
  mode: Mode;
  onMode: (m: Mode) => void;
  genre: string;
  onGenre: (g: string) => void;
  protagonist: string;
  onProtagonist: (p: string) => void;
  canStart: boolean;
  onStart: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 rounded border border-line bg-card p-6">
      <p className="font-serif text-3xl font-bold text-ink">世界线收束物语</p>
      <p className="max-w-md text-center font-serif text-sm leading-relaxed text-ink-soft">
        你的每个选择都会与世界线产生矛盾，而世界线会消化矛盾。结局由全程选择的积累决定。
      </p>
      <div className="flex w-full max-w-md flex-col gap-2">
        <div className="flex items-center gap-3 text-sm text-ink">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={props.mode === "play"}
              onChange={() => props.onMode("play")}
            />
            自己玩
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={props.mode === "spectate"}
              onChange={() => props.onMode("spectate")}
            />
            观战（双 agent）
          </label>
        </div>
        <textarea
          className="min-h-20 w-full rounded border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-soft/60"
          placeholder={"题材 / 世界观（留空由 GM 随机选定）\n可以写得很具体：时代、地点、基调、想看到什么……"}
          value={props.genre}
          onChange={(e) => props.onGenre(e.target.value)}
        />
        <input
          className="w-full rounded border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-soft/60"
          placeholder="主角（留空由 GM 代拟）：姓名、身份、一句话性格"
          value={props.protagonist}
          onChange={(e) => props.onProtagonist(e.target.value)}
        />
      </div>
      {props.canStart ? (
        <button
          className="rounded bg-vermilion px-5 py-2 font-medium text-paper hover:opacity-90"
          onClick={props.onStart}
        >
          开始观测
        </button>
      ) : (
        <button
          className="rounded border border-line bg-paper-dim px-4 py-1.5 text-sm text-ink hover:bg-line"
          onClick={props.onOpenSettings}
        >
          先到 ⚙ 模型里配置端点
        </button>
      )}
    </div>
  );
}
