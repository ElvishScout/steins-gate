import { useState } from "react";

export function InputBar(props: { options: string[]; onSubmit: (action: string) => void }) {
  const [freeInput, setFreeInput] = useState("");
  const submitFree = () => {
    const t = freeInput.trim();
    if (!t) return;
    props.onSubmit(t);
    setFreeInput("");
  };

  return (
    <div className="flex flex-col gap-2">
      {props.options.length > 0 && (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {props.options.map((o, i) => (
            <button
              key={i}
              type="button"
              className="group flex cursor-pointer items-start gap-2 rounded-lg border border-line bg-paper/60 px-2.5 py-1.5 text-left text-xs leading-snug text-ink transition hover:border-vermilion/60 hover:bg-vermilion/[0.04] sm:text-sm"
              onClick={() => props.onSubmit(o)}
            >
              <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-line bg-card font-mono text-[11px] font-medium text-ink-soft group-hover:border-vermilion/50 group-hover:text-vermilion">
                {i + 1}
              </span>
              <span className="flex-1">{o}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <input
          className="flex-1 rounded-lg border border-line bg-paper/60 px-3 py-1.5 text-sm text-ink placeholder:text-ink-soft/60 transition focus:border-vermilion focus:bg-card focus:outline-none"
          placeholder="或者自由输入任何行动（按 Enter 发送）…"
          value={freeInput}
          onChange={(e) => setFreeInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitFree();
          }}
        />
        <button
          type="button"
          className="shrink-0 cursor-pointer rounded-lg bg-vermilion px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-vermilion/90 disabled:cursor-not-allowed disabled:opacity-40 sm:text-sm"
          disabled={!freeInput.trim()}
          onClick={submitFree}
        >
          发送
        </button>
      </div>
    </div>
  );
}
