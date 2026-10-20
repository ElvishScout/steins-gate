import { useState } from "react";
import type { GmState } from "../llm/types";
import type { DebugInfo } from "./entries";

const CHECKPOINT_STATUS: Record<string, { label: string; style: string }> = {
  pending: { label: "未触发", style: "text-ink-soft" },
  triggered: { label: "已触发", style: "font-medium text-ink" },
  deceived: { label: "已欺骗", style: "font-medium text-vermilion" },
  void: { label: "作废", style: "text-ink-soft/50 line-through" },
};

const MAGNITUDE: Record<string, string> = {
  subtle: "细微",
  notable: "显著",
  fundamental: "根本",
};

/** 隐藏状态的结构化渲染：世界线读数、检查点带状态、未消化矛盾清单。 */
function StateView({ state }: { state: GmState }) {
  const active = state.contradictions.filter((c) => c.status === "active");
  return (
    <div className="mt-1.5 flex flex-col gap-1 border-t border-line/80 pt-1.5">
      <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
        <span className="font-semibold text-ink">{state.worldline} 线</span>
        <span className="text-vermilion">{state.divergence.toFixed(6)}%</span>
        <span className="text-ink-soft">/ 壁垒 {state.barrier.toFixed(6)}%</span>
      </div>

      {state.checkpoints.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {state.checkpoints.map((c) => {
            const st = CHECKPOINT_STATUS[c.status] ?? {
              label: c.status,
              style: "text-ink-soft",
            };
            return (
              <li key={c.id} className="text-xs leading-snug text-ink-soft">
                <span className="font-mono">{c.id}</span> <span className={st.style}>[{st.label}]</span>{" "}
                <span className="text-ink">{c.content}</span>
                {c.conditions.length > 0 && (
                  <span className="text-ink-soft/75">
                    {" "}
                    （{c.conditions.map((x) => `${x.condition}·${x.via === "cognition" ? "认知" : "事实"}`).join("；")}
                    ）
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {active.length > 0 && (
        <ul className="flex flex-col gap-0.5 border-t border-line/50 pt-1">
          {active.map((c) => (
            <li key={c.id} className="text-xs leading-snug text-ink-soft">
              <span className="font-mono text-ink">{c.id}</span>{" "}
              <span>
                [{MAGNITUDE[c.magnitude] ?? c.magnitude}
                {c.breach ? "·击穿" : ""}]
              </span>{" "}
              <span className="text-ink">{c.text}</span>
              {c.related && <span>（关联 {c.related}）</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NoteBody({ info }: { info: DebugInfo }) {
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {info.events.map((ev, i) =>
        ev.type === "reasoning" ? (
          <p key={i} className="font-mono text-xs leading-normal whitespace-pre-wrap text-ink-soft">
            {ev.text}
          </p>
        ) : (
          <details key={i} className="rounded border border-line bg-card px-2 py-1 text-xs">
            <summary className="cursor-pointer font-mono text-xs select-none">
              <span className={ev.error ? "text-vermilion" : "text-ink"}>⚙ {ev.name}</span>
              {ev.error && <span className="text-vermilion"> ✗ {ev.error}</span>}
            </summary>
            <pre className="mt-1 overflow-x-auto font-mono text-[11px] leading-snug text-ink-soft">
              {JSON.stringify(ev.args, null, 2)}
            </pre>
          </details>
        ),
      )}
      {info.state && <StateView state={info.state} />}
    </div>
  );
}

/** 折叠时的一行预览：第一段思维链合并成一行（换行变空格），没有思维链则列工具名。 */
function previewOf(info: DebugInfo): string {
  const first = info.events.find((e) => e.type === "reasoning");
  if (first && first.type === "reasoning") return first.text.trim().replace(/\s*\n\s*/g, " ");
  return info.events
    .filter((e) => e.type === "tool")
    .map((e) => e.name)
    .join(" → ");
}

/** 一幕的幕后记录。默认收起（一行预览），手动展开。无内容时不渲染。 */
export function DebugNote({ info }: { info: DebugInfo; live?: boolean }) {
  const [collapsed, setCollapsed] = useState(true);
  if (info.events.length === 0 && !info.state) return null;

  if (collapsed) {
    return (
      <button
        type="button"
        className="mb-1.5 flex w-full cursor-pointer items-center gap-1.5 rounded-md border border-line/80 bg-paper px-2.5 py-1 text-left font-mono text-xs text-ink-soft transition hover:border-ink-soft/40 hover:text-ink select-none"
        onClick={() => setCollapsed(false)}
        title="展开隐藏推理与世界线状态"
      >
        <span className="shrink-0 text-vermilion">▸</span>
        <span className="truncate">{previewOf(info) || "状态快照"}</span>
        {info.state && (
          <span className="ml-auto shrink-0 text-[11px] text-ink-soft">
            {info.state.worldline} · {info.state.divergence.toFixed(6)}%
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="mb-2 rounded-lg border border-line bg-paper p-2.5">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center justify-between text-left font-mono text-xs text-ink-soft hover:text-ink select-none"
        onClick={() => setCollapsed(true)}
        title="折叠"
      >
        <span>▾ 收起</span>
        {info.state && (
          <span className="text-[11px]">
            {info.state.worldline} · {info.state.divergence.toFixed(6)}%
          </span>
        )}
      </button>
      <NoteBody info={info} />
    </div>
  );
}
