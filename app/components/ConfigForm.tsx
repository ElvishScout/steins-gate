import type { LLMConfig } from "../llm/types";

export const EMPTY_CONFIG: LLMConfig = { baseURL: "", apiKey: "", model: "" };

export function ConfigForm(props: {
  label: string;
  value: LLMConfig;
  onChange: (c: LLMConfig) => void;
  onTest: () => void;
  testing: boolean;
}) {
  const { label, value, onChange } = props;
  const field = (name: keyof LLMConfig, placeholder: string, type = "text") => (
    <input
      className="w-full rounded border border-line bg-white px-2 py-1 text-sm text-ink placeholder:text-ink-soft/60"
      placeholder={placeholder}
      type={type}
      value={(value[name] as string) ?? ""}
      onChange={(e) => onChange({ ...value, [name]: e.target.value })}
    />
  );
  return (
    <fieldset className="flex flex-col gap-2 rounded border border-line bg-card p-3">
      <legend className="px-1 text-xs text-ink-soft">{label}</legend>
      {field("baseURL", "baseURL，如 https://你的中转/v1")}
      {field("apiKey", "apiKey", "password")}
      {field("model", "model，如 deepseek-chat")}
      <select
        className="w-full rounded border border-line bg-white px-2 py-1 text-sm text-ink"
        value={value.reasoningEffort ?? ""}
        onChange={(e) =>
          onChange({
            ...value,
            reasoningEffort: (e.target.value || undefined) as LLMConfig["reasoningEffort"],
          })
        }
      >
        <option value="">reasoning effort：默认（不传）</option>
        <option value="none">reasoning effort: none</option>
        <option value="low">reasoning effort: low</option>
        <option value="medium">reasoning effort: medium</option>
        <option value="high">reasoning effort: high</option>
      </select>
      <button
        className="self-start rounded border border-line bg-paper-dim px-2 py-1 text-xs text-ink hover:bg-line disabled:opacity-40"
        onClick={props.onTest}
        disabled={props.testing || !value.baseURL || !value.apiKey || !value.model}
      >
        {props.testing ? "测试中…" : "测试连接"}
      </button>
    </fieldset>
  );
}
