import { useEffect, useRef } from "react";
import { DebugNote } from "./DebugNote";
import type { Entry } from "./entries";

/** 生成中的流式内容：GM 的正文 + 附注事件流，或玩家 agent 的行动 + 思维链 */
export interface LiveGM {
  narration: string;
  events: import("../llm/types").GmDebugEvent[];
}
export interface LivePlayer {
  text: string;
  reasoning: string;
}

export function StoryLog(props: {
  entries: Entry[];
  live: LiveGM | null;
  playerLive: LivePlayer | null;
  showHidden: boolean;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  /** 上一 commit 的 scrollHeight：内容追加前的容器高度 */
  const prevHeightRef = useRef<number | null>(null);
  /** 上次已知的贴底状态：内容 effect 与用户滚动都会更新它，供 resize 时判定 */
  const stickRef = useRef(true);

  // 内容追加：按吐字前几何判定（不等异步 scroll 事件）
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const prevH = prevHeightRef.current ?? el.scrollHeight;
    const wasAtBottom = prevH - el.scrollTop - el.clientHeight < 10;
    stickRef.current = wasAtBottom;
    if (wasAtBottom) el.scrollTo(0, el.scrollHeight);
    prevHeightRef.current = el.scrollHeight;
  }, [props.entries, props.live, props.playerLive]);

  // 容器尺寸变化（底栏弹出/收起、窗口缩放）：跟随上次已知的贴底状态
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTo(0, el.scrollHeight);
      prevHeightRef.current = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={logRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 10;
      }}
      className="flex h-full flex-col gap-5 overflow-y-auto rounded border border-line bg-card p-5"
    >
      {props.entries.map((e, i) => {
        if (e.kind === "scene") {
          return (
            <section key={i}>
              {props.showHidden && <DebugNote info={e.debug} />}
              <div className="mt-2 font-serif leading-relaxed whitespace-pre-wrap text-ink">
                {e.narration}
              </div>
            </section>
          );
        }
        if (e.kind === "action") {
          return (
            <section key={i}>
              {props.showHidden && e.debug && e.debug.events.length > 0 && (
                <DebugNote info={e.debug} />
              )}
              <div className="mt-2 border-l-2 border-vermilion pl-3">
                {e.by === "human" && (
                  <span className="mr-2 text-xs text-ink-soft">你的行动</span>
                )}
                <span className="whitespace-pre-wrap text-vermilion">{e.text}</span>
              </div>
            </section>
          );
        }
        if (e.kind === "ending") {
          return (
            <section key={i} className="rounded border-2 border-vermilion bg-paper-dim p-4">
              <h2 className="mb-2 font-serif font-bold text-vermilion">{e.title}</h2>
              <div className="font-serif text-sm leading-relaxed whitespace-pre-wrap text-ink">
                {e.yearbook}
              </div>
              {props.showHidden && <DebugNote info={e.debug} />}
            </section>
          );
        }
        return (
          <section key={i} className="text-vermilion">
            ⚠ {e.text}
          </section>
        );
      })}

      {props.live && (
        <section>
          {props.showHidden && props.live.events.length > 0 && (
            <DebugNote live info={{ events: props.live.events, state: null }} />
          )}
          <div className="mt-2 font-serif leading-relaxed whitespace-pre-wrap text-ink">
            {props.live.narration}
            <span className="animate-caret text-vermilion">▌</span>
          </div>
        </section>
      )}

      {props.playerLive && (
        <section>
          {props.showHidden && props.playerLive.reasoning && (
            <DebugNote
              live
              info={{
                events: [{ type: "reasoning", text: props.playerLive.reasoning }],
                state: null,
              }}
            />
          )}
          <div className="mt-2 border-l-2 border-vermilion pl-3">
            <span className="whitespace-pre-wrap text-vermilion">
              {props.playerLive.text}
              <span className="animate-caret">▌</span>
            </span>
          </div>
        </section>
      )}
    </div>
  );
}
