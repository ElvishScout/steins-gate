export interface LLMConfig {
  /** 用户自己的中转/官方端点，如 https://api.deepseek.com/v1 */
  baseURL: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: "none" | "low" | "medium" | "high";
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type Difficulty = "easy" | "standard" | "hard";

export interface GameSetup {
  genre?: string;
  protagonist?: string;
  difficulty: Difficulty;
}

export type CheckpointStatus = "pending" | "triggered" | "deceived" | "void";

/** 承重条件的传导方式：cognition 经由某人的认知（可伪造观测）；fact 经由事实本身（不可伪造，只可真实促成） */
export type ConditionVia = "cognition" | "fact";

/** 承重条件：这条因果链断在哪一环就接不上。检查点的"锚定"不是整体类型，而是逐条件的。 */
export interface CausalCondition {
  condition: string;
  via: ConditionVia;
}

export interface Checkpoint {
  id: string;
  content: string;
  /** 上游依赖：它承接哪些先前节点撬动的因果——没有上游，这个节点就不会存在 */
  upstream: string[];
  conditions: CausalCondition[];
  status: CheckpointStatus;
  note?: string;
}

/**
 * 矛盾量级（= 行动与既定因果链的冲突程度）：
 * subtle 细微（善缘/伏笔/后手/细节错位，不改线但铺设结局因果链）
 * notable 显著（动摇检查点非承重环节）
 * fundamental 根本（斩断/替代承重条件——唯一参与跳线判定的量级）
 */
export type ContradictionMagnitude = "subtle" | "notable" | "fundamental";

/** active 未消化 / digested 已被世界消化（收束吸收、修复性行动消解）/ void 作废（欺骗失败暴露的伏笔） */
export type ContradictionStatus = "active" | "digested" | "void";

/**
 * 矛盾账本条目（本游戏唯一的隐藏账本）：玩家行动造成的、与当前世界线
 * 既定因果链相冲突的事实或状态。结下的善缘、埋下的伏笔、留下的后手、
 * 细节的错位、被斩断的因果，全部是矛盾，只是量级不同。
 */
export interface Contradiction {
  id: string;
  act: number;
  text: string;
  magnitude: ContradictionMagnitude;
  /** 它造成的读数跳动（有符号，六位小数） */
  delta: number;
  /** 关联的检查点 id（欺骗判定、收束吸收的依据） */
  related?: string;
  /** 直接击穿核心节点：一次即可撕裂因果链 */
  breach?: boolean;
  status: ContradictionStatus;
  note?: string;
}

/** 引擎持有的权威 GM 状态（对玩家不可见；观战者可见） */
export interface GmState {
  act: number;
  worldline: string;
  /** 变动率是未消化矛盾总量的读数，不是独立累加的数值：矛盾被消化，读数可以回落 */
  divergence: number;
  barrier: number;
  checkpoints: Checkpoint[];
  contradictions: Contradiction[];
  history: string[];
  ending?: { tier: string; title: string } | null;
}

/** 场景边界：GM 递交选项、游戏挂起等待玩家行动时的快照。 */
export interface Scene {
  act: number;
  narration: string;
  options: string[];
  state: GmState;
}

/** declare_ending 捕获的终局。 */
export interface Ending {
  tier: string;
  title: string;
  yearbook: string;
}
