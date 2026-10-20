import { PLAYER_STYLES, type PlayerStyleId } from "../llm/prompts/player";
import type { Mode } from "./entries";

/**
 * 开局面板（未开局时占据主区域）：模式、题材（多行）、主角设定、观战玩家风格 + 开始按钮。
 */
export function SetupPanel(props: {
  mode: Mode;
  onMode: (m: Mode) => void;
  genre: string;
  onGenre: (g: string) => void;
  protagonist: string;
  onProtagonist: (p: string) => void;
  playerStyle: PlayerStyleId;
  onPlayerStyle: (s: PlayerStyleId) => void;
  canStart: boolean;
  onStart: () => void;
  onOpenSettings: () => void;
}) {
  const fieldClass =
    "w-full rounded-lg border border-line bg-paper/50 px-3 py-2 text-sm text-ink placeholder:text-ink-soft/55 transition focus:border-vermilion focus:bg-card focus:outline-none";

  return (
    <div className="mx-auto my-2 flex w-full max-w-xl flex-col items-center rounded-xl border border-line bg-card p-5 shadow-2xs sm:my-4 sm:p-6">
      <p className="font-mono text-xs tracking-widest text-vermilion">1.048596% · EL PSY KONGROO</p>
      <h2 className="mt-0.5 font-serif text-2xl font-bold tracking-tight text-ink sm:text-3xl">命运石之门</h2>
      <p className="mt-1.5 max-w-md text-center font-serif text-xs leading-relaxed text-ink-soft sm:text-sm">
        世界没有开始，也没有结束——有的只是无限延伸的因果，与观测者一瞬的抉择。
      </p>

      <div className="mt-4 flex w-full flex-col gap-2.5">
        <div className="grid grid-cols-2 gap-1 rounded-lg border border-line bg-paper p-1">
          <button
            type="button"
            onClick={() => props.onMode("play")}
            className={`cursor-pointer rounded-md py-1.5 text-xs font-medium transition sm:text-sm ${
              props.mode === "play" ? "bg-card text-ink shadow-2xs" : "text-ink-soft hover:text-ink"
            }`}
          >
            自己玩
          </button>
          <button
            type="button"
            onClick={() => props.onMode("spectate")}
            className={`cursor-pointer rounded-md py-1.5 text-xs font-medium transition sm:text-sm ${
              props.mode === "spectate" ? "bg-card text-ink shadow-2xs" : "text-ink-soft hover:text-ink"
            }`}
          >
            观战（双 Agent）
          </button>
        </div>

        <textarea
          rows={3}
          className={`${fieldClass} resize-y leading-relaxed`}
          placeholder={"题材 / 世界观（留空由 GM 随机选定）\n可以写得很具体：时代、地点、基调、想看到什么……"}
          value={props.genre}
          onChange={(e) => props.onGenre(e.target.value)}
        />

        <input
          className={fieldClass}
          placeholder="主角（留空由 GM 代拟）：姓名、身份、一句话性格"
          value={props.protagonist}
          onChange={(e) => props.onProtagonist(e.target.value)}
        />

        {props.mode === "spectate" && (
          <div className="flex flex-col gap-1">
            <select
              className={fieldClass}
              value={props.playerStyle}
              onChange={(e) => props.onPlayerStyle(e.target.value as PlayerStyleId)}
            >
              {PLAYER_STYLES.map((s) => (
                <option key={s.id} value={s.id}>
                  玩家风格：{s.label}
                </option>
              ))}
            </select>
            <p className="px-1 text-xs leading-normal text-ink-soft">
              {PLAYER_STYLES.find((s) => s.id === props.playerStyle)?.persona}
            </p>
          </div>
        )}
      </div>

      <div className="mt-4 w-full">
        {props.canStart ? (
          <button
            type="button"
            className="w-full cursor-pointer rounded-lg bg-vermilion px-5 py-2 text-sm font-semibold text-white transition hover:bg-vermilion/90"
            onClick={props.onStart}
          >
            开始观测
          </button>
        ) : (
          <button
            type="button"
            className="w-full cursor-pointer rounded-lg border border-dashed border-ink-soft/40 bg-paper px-4 py-2 text-xs font-medium text-ink transition hover:border-vermilion hover:text-vermilion sm:text-sm"
            onClick={props.onOpenSettings}
          >
            先到 ⚙ 模型里配置端点
          </button>
        )}
      </div>
    </div>
  );
}
