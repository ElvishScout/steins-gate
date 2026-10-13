import type { GmDebugEvent, GmState } from "../llm/types";

export type Mode = "play" | "spectate";

/** 一幕（或结局）的附注内容：交织事件流 + 该幕最终状态快照 */
export interface DebugInfo {
  events: GmDebugEvent[];
  state: GmState | null;
}

export type Entry =
  | { kind: "scene"; act: number; narration: string; options: string[]; debug: DebugInfo }
  | { kind: "action"; text: string; by: "human" | "player-agent"; debug?: DebugInfo }
  | { kind: "ending"; title: string; yearbook: string; debug: DebugInfo }
  | { kind: "error"; text: string };
