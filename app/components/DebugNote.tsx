import { useState } from "react";
import type { GmState } from "../llm/types";
import type { DebugInfo } from "./entries";

const CHECKPOINT_STATUS: Record<string, string> = {
  pending: "未触发",
  triggered: "已触发",
  deceived: "已欺骗",
  void: "作废",
};

const MAGNITUDE: Record<string, string> = {
  subtle: "细微",
  notable: "显著",
  fundamental: "根本",
};

/** 隐藏状态的结构化渲染：世界线读数一行、检查点带状态、未消化矛盾清单。 */
function StateView({ state }: { state: GmState }) {
  const active = state.contradictions.filter((c) => c.status === "active");
  return (
    <div className="mt-2 border-t border-line pt-2">
      <p className="font-mono text-xs text-ink">
        {state.worldline} 线 · {state.divergence.toFixed(6)}% / 壁垒 {state.barrier.toFixed(6)}%
      </p>
      {state.checkpoints.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {state.checkpoints.map((c) => (
            <li key={c.id} className="text-xs text-ink-soft">
              <span className="font-mono">{c.id}</span>{" "}
              <span
                className={
                  c.status === "deceived"
                    ? "text-vermilion"
                    : c.status === "triggered"
                      ? "text-ink"
                      : undefined
                }
              >
                [{CHECKPOINT_STATUS[c.status] ?? c.status}]
              </span>{" "}
              {c.content}
              <span className="text-ink-soft/70">
                {" "}
                （{c.conditions.map((x) => `${x.condition}·${x.via === "cognition" ? "认知" : "事实"}`).join("；")}）
              </span>
            </li>
          ))}
        </ul>
      )}
      {active.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {active.map((c) => (
            <li key={c.id} className="text-xs text-ink-soft">
              <span className="font-mono">{c.id}</span> [{MAGNITUDE[c.magnitude] ?? c.magnitude}
              {c.breach ? "·击穿" : ""}] {c.text}
              {c.related ? `（关联 ${c.related}）` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NoteBody({ info }: { info: DebugInfo }) {
  return (
    <div className="mt-2">
      {info.events.map((ev, i) =>
        ev.type === "reasoning" ? (
          <p key={i} className="mb-2 font-mono text-xs whitespace-pre-wrap text-ink-soft">
            {ev.text}
          </p>
        ) : (
          <details key={i} className="mb-1 rounded border border-line bg-card px-2 py-1">
            <summary className="cursor-pointer font-mono text-xs select-none">
              <span className={ev.error ? "text-vermilion" : "text-ink"}>⚙ {ev.name}</span>
              {ev.error && <span className="text-vermilion"> ✗ {ev.error}</span>}
            </summary>
            <pre className="mt-1 overflow-x-auto font-mono text-xs text-ink-soft">
              {JSON.stringify(ev.args, null, 2)}
            </pre>
          </details>
        ),
      )}
      {info.state && <StateView state={info.state} />}
    </div>
  );
}

/** 折叠时的一行预览：第一段思维链合并成一行（换行变空格），没有思维链则列工具名。CSS truncate 自带省略号。 */
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
        className="mt-1 block w-full cursor-pointer truncate rounded border border-line bg-paper-dim px-3 py-1 text-left font-mono text-xs text-ink-soft select-none"
        onClick={() => setCollapsed(false)}
        title="展开"
      >
        ▸ {previewOf(info)}
      </button>
    );
  }
  return (
    <div className="mt-2 rounded border border-line bg-paper-dim px-3 py-2">
      <button
        className="block w-full cursor-pointer text-left font-mono text-xs text-ink-soft select-none"
        onClick={() => setCollapsed(true)}
        title="折叠"
      >
        ▾ 收起
      </button>
      <NoteBody info={info} />
    </div>
  );
}
