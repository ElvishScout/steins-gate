import { PLAYER_STYLES, type PlayerStyleId } from "../llm/prompts/player";
import type { Difficulty, GmDebugEvent } from "../llm/types";
import type { DebugInfo, Entry, Mode } from "./entries";

export interface ExportHistoryOptions {
  entries: Entry[];
  includeReasoning: boolean;
  includeTools: boolean;
  mode: Mode;
  difficulty: Difficulty;
  genre: string;
  protagonist: string;
  playerStyle: PlayerStyleId;
  gmModel?: string;
  playerModel?: string;
}

const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: "轻松 (0.62~0.78%)",
  standard: "标准 (0.38~0.58%)",
  hard: "残酷 (0.09~0.34%)",
};

function formatReasoningBlock(text: string): string {
  const lines = text.trim().split(/\r?\n/);
  return ["> **💭 思维链**", ">", ...lines.map((line) => (line ? `> ${line}` : ">"))].join("\n");
}

function formatToolBlock(ev: Extract<GmDebugEvent, { type: "tool" }>): string {
  const errSuffix = ev.error ? `（✗ ${ev.error}）` : "";
  const jsonLines = JSON.stringify(ev.args, null, 2).split("\n");
  return [
    `> **⚙ 工具调用：\`${ev.name}\`${errSuffix}**`,
    "> ```json",
    ...jsonLines.map((line) => `> ${line}`),
    "> ```",
  ].join("\n");
}

function formatDebugEvents(
  debug: DebugInfo | undefined,
  includeReasoning: boolean,
  includeTools: boolean,
): string[] {
  if (!debug || (!includeReasoning && !includeTools)) return [];
  const blocks: string[] = [];
  for (const ev of debug.events) {
    if (ev.type === "reasoning" && includeReasoning) {
      if (ev.text.trim()) blocks.push(formatReasoningBlock(ev.text));
    } else if (ev.type === "tool" && includeTools) {
      blocks.push(formatToolBlock(ev));
    }
  }
  return blocks;
}

function formatTimestamp(d: Date): { display: string; filePart: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return {
    display: `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`,
    filePart: `${yyyy}${mm}${dd}-${hh}${min}${ss}`,
  };
}

export function buildHistoryMarkdown(opts: ExportHistoryOptions, now = new Date()): string {
  const { display } = formatTimestamp(now);
  const styleLabel = PLAYER_STYLES.find((s) => s.id === opts.playerStyle)?.label ?? opts.playerStyle;
  const modeText = opts.mode === "play" ? "自己玩" : `观战（双 Agent · ${styleLabel}）`;
  const genreText = opts.genre.trim().replace(/\s*\n\s*/g, " / ") || "未指定（由 GM 随机选定）";
  const protagonistText = opts.protagonist.trim() || "未指定（由 GM 代拟）";
  const modelText =
    opts.mode === "spectate"
      ? `GM: ${opts.gmModel || "未指定"} / 玩家: ${opts.playerModel || "未指定"}`
      : `GM: ${opts.gmModel || "未指定"}`;

  const sections: string[] = [
    "# 命运石之门 · 对话历史",
    [
      `- **模式**：${modeText}`,
      `- **难度**：${DIFFICULTY_LABEL[opts.difficulty]}`,
      `- **题材 / 世界观**：${genreText}`,
      `- **主角设定**：${protagonistText}`,
      `- **模型**：${modelText}`,
      `- **导出时间**：${display}`,
    ].join("\n"),
    "---",
  ];

  for (const e of opts.entries) {
    if (e.kind === "scene") {
      const parts: string[] = [
        `## 第 ${e.act} 幕`,
        ...formatDebugEvents(e.debug, opts.includeReasoning, opts.includeTools),
        e.narration,
      ];
      if (e.options.length > 0) {
        const optionLines = e.options.map((o, i) => `${i + 1}. ${o}`).join("\n");
        parts.push(`**分支选项：**\n${optionLines}`);
      }
      sections.push(parts.join("\n\n"));
    } else if (e.kind === "action") {
      const parts: string[] = [
        "### 玩家行动",
        ...formatDebugEvents(e.debug, opts.includeReasoning, opts.includeTools),
        e.text,
      ];
      sections.push(parts.join("\n\n"));
    } else if (e.kind === "ending") {
      const parts: string[] = [
        `## 终局年鉴：${e.title}`,
        ...formatDebugEvents(e.debug, opts.includeReasoning, opts.includeTools),
        e.yearbook,
      ];
      sections.push(parts.join("\n\n"));
    } else if (e.kind === "error") {
      sections.push(`> **⚠ 错误**：${e.text}`);
    }
  }

  return sections.join("\n\n") + "\n";
}

export function downloadHistoryMarkdown(opts: ExportHistoryOptions): void {
  const now = new Date();
  const content = buildHistoryMarkdown(opts, now);
  const { filePart } = formatTimestamp(now);
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `命运石之门-${filePart}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function copyHistoryMarkdown(opts: ExportHistoryOptions): Promise<void> {
  const content = buildHistoryMarkdown(opts, new Date());
  await navigator.clipboard.writeText(content);
}
