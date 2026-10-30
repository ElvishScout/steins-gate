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

const STICK_THRESHOLD_PX = 64;

function isWindowNearBottom(scrollHeight?: number): boolean {
  const doc = document.documentElement;
  const h = scrollHeight ?? doc.scrollHeight;
  return h - window.scrollY - window.innerHeight < STICK_THRESHOLD_PX;
}

function scrollToPageBottom(): void {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
}

export function StoryLog(props: {
  entries: Entry[];
  live: LiveGM | null;
  playerLive: LivePlayer | null;
  busy: boolean;
  showHidden: boolean;
  onRetry?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  /** 上一 commit 的文档高度：内容追加前的整页高度 */
  const prevHeightRef = useRef<number | null>(null);
  /** 上次已知的整页贴底状态 */
  const stickRef = useRef(true);

  // 监听整页滚动，记录用户是否停留在页面底部附近
  useEffect(() => {
    const onScroll = () => {
      stickRef.current = isWindowNearBottom();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // 内容追加：按追加前的整页几何判定是否自动跟随到底部
  useEffect(() => {
    const doc = document.documentElement;
    const prevH = prevHeightRef.current ?? doc.scrollHeight;
    const wasAtBottom = isWindowNearBottom(prevH);
    stickRef.current = wasAtBottom;
    if (wasAtBottom) scrollToPageBottom();
    prevHeightRef.current = doc.scrollHeight;
  }, [props.entries, props.live, props.playerLive, props.onRetry]);

  // 页面内容尺寸变化（底栏展开/收起、详情折叠、窗口缩放）：跟随上次已知贴底状态
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) scrollToPageBottom();
      prevHeightRef.current = document.documentElement.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="flex flex-col gap-2.5">
      {props.entries.map((e, i) => {
        if (e.kind === "scene") {
          return (
            <article key={i} className="rounded-xl border border-line bg-card px-4 py-3 shadow-2xs print:shadow-none">
              <div className="mb-1.5 flex items-center justify-between border-b border-line/60 pb-1">
                <span className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold text-ink-soft">
                  <span className="h-1.5 w-1.5 rounded-full bg-vermilion/80" />
                  <span>第 {e.act} 幕</span>
                </span>
                <span className="font-mono text-[11px] text-ink-soft/60">ACT {String(e.act).padStart(2, "0")}</span>
              </div>

              {props.showHidden && <DebugNote info={e.debug} />}

              <div className="font-serif text-[15.5px] leading-[1.75] whitespace-pre-wrap text-ink">{e.narration}</div>
            </article>
          );
        }

        if (e.kind === "action") {
          return (
            <div key={i}>
              {props.showHidden && e.debug && e.debug.events.length > 0 && <DebugNote info={e.debug} />}
              <div className="rounded-lg border border-l-3 border-vermilion/25 border-l-vermilion bg-vermilion/4 px-3 py-1.5 text-sm">
                <span className="font-serif whitespace-pre-wrap text-vermilion">{e.text}</span>
              </div>
            </div>
          );
        }

        if (e.kind === "ending") {
          return (
            <article
              key={i}
              className="rounded-xl border-2 border-vermilion bg-card px-4 py-3.5 shadow-xs print:shadow-none"
            >
              {props.showHidden && <DebugNote info={e.debug} />}
              <div className="flex items-center gap-2">
                <span className="rounded bg-vermilion/10 px-2 py-0.5 font-mono text-[11px] font-semibold text-vermilion">
                  终局年鉴
                </span>
                <h2 className="font-serif text-lg font-bold text-vermilion">{e.title}</h2>
              </div>
              <div className="mt-2 border-t border-line pt-2 font-serif text-[15px] leading-[1.75] whitespace-pre-wrap text-ink">
                {e.yearbook}
              </div>
            </article>
          );
        }

        return (
          <div
            key={i}
            className="flex items-start gap-2 rounded-lg border border-vermilion/30 bg-vermilion/10 px-3 py-2 text-xs text-vermilion sm:text-sm"
          >
            <span className="shrink-0 font-bold">⚠</span>
            <span className="whitespace-pre-wrap">{e.text}</span>
          </div>
        );
      })}

      {props.live && (
        <article className="rounded-xl border border-line bg-card px-4 py-3 shadow-2xs">
          {props.showHidden && props.live.events.length > 0 && (
            <DebugNote live={props.busy} info={{ events: props.live.events, state: null }} />
          )}
          <div className="font-serif text-[15.5px] leading-[1.75] whitespace-pre-wrap text-ink">
            {props.live.narration}
            {props.busy && <span className="ml-0.5 animate-caret text-vermilion">▌</span>}
          </div>
        </article>
      )}

      {props.playerLive && (
        <div>
          {props.showHidden && props.playerLive.reasoning && (
            <DebugNote
              live={props.busy}
              info={{
                events: [{ type: "reasoning", text: props.playerLive.reasoning }],
                state: null,
              }}
            />
          )}
          <div className="rounded-lg border border-l-3 border-vermilion/25 border-l-vermilion bg-vermilion/4 px-3 py-1.5 text-sm">
            <span className="font-serif whitespace-pre-wrap text-vermilion">
              {props.playerLive.text}
              {props.busy && <span className="ml-0.5 animate-caret text-vermilion">▌</span>}
            </span>
          </div>
        </div>
      )}

      {!props.busy && props.onRetry && (
        <div className="flex justify-start print:hidden">
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-vermilion/35 bg-card px-3 py-1.5 text-xs font-medium text-vermilion shadow-2xs transition hover:border-vermilion hover:bg-vermilion/5 sm:text-sm"
            onClick={props.onRetry}
          >
            <span>↻</span>
            <span>重试</span>
          </button>
        </div>
      )}
    </div>
  );
}
