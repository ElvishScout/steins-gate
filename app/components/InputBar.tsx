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
        <div className="flex flex-wrap gap-2">
          {props.options.map((o, i) => (
            <button
              key={i}
              className="rounded border border-line bg-card px-3 py-1 text-sm text-ink hover:border-vermilion hover:text-vermilion"
              onClick={() => props.onSubmit(o)}
            >
              {o}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          className="flex-1 rounded border border-line bg-white px-2 py-1 text-sm text-ink placeholder:text-ink-soft/60"
          placeholder="或者自由输入任何行动…"
          value={freeInput}
          onChange={(e) => setFreeInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitFree();
          }}
        />
        <button
          className="rounded bg-vermilion px-3 py-1 text-sm text-paper hover:opacity-90 disabled:opacity-40"
          disabled={!freeInput.trim()}
          onClick={submitFree}
        >
          发送
        </button>
      </div>
    </div>
  );
}
