import { streamTurn, type ToolSpec } from "./llm";
import type { ChatMessage, LLMConfig, ToolCall } from "./types";

export interface AgentTool extends ToolSpec {
  /** 返回值会 JSON 序列化为 tool result 回给模型；抛异常会以错误文本回填。
   *  可以 async——比如挂起等待用户输入（Claude Code 的 AskUserQuestion 模式）。 */
  run: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

const MAX_TOOL_ROUNDS = 8;
const noop = () => {};

/**
 * 一个最小 agent：system prompt + 对话历史 + 回合推进。
 * 每次回合是一次（带 tools 的）流式补全 + 必要的工具结果回填循环。
 */
export class Agent {
  readonly name: string;
  history: ChatMessage[] = [];

  constructor(
    readonly config: LLMConfig,
    systemPrompt: string,
    name = "agent",
  ) {
    this.name = name;
    this.history.push({ role: "system", content: systemPrompt });
  }

  /**
   * 推进一个回合：流式产出正文（onChunk 实时回调），若模型发出 tool_calls，
   * 执行并回填结果后继续，直到模型不再调用工具为止。
   * 所有轮次的文本都会流出并拼进返回值：模型可能先调工具再写正文
   * （比如开局先 define_checkpoints），只取第一轮会吞掉正文。
   */
  async runTurn(
    userInput: string,
    opts?: {
      tools?: AgentTool[];
      onChunk?: (delta: string) => void;
      /** 思维链增量（模型不吐 reasoning 时永不触发）；只进 UI，不回写历史 */
      onReasoning?: (delta: string) => void;
      signal?: AbortSignal;
      /** 工具调用轮数上限（GM 整局一条循环，要给足；默认 8） */
      maxRounds?: number;
      /** 终止性工具：执行成功后立即结束循环（如 declare_ending）；执行报错不算 */
      terminal?: string[];
    },
  ): Promise<{ text: string; called: string[] }> {
    this.history.push({ role: "user", content: userInput });
    const onChunk = opts?.onChunk ?? noop;
    const onReasoning = opts?.onReasoning ?? noop;
    const called: string[] = [];
    let fullText = "";

    for (let round = 0; round < (opts?.maxRounds ?? MAX_TOOL_ROUNDS); round++) {
      let roundText = "";
      let toolCalls: ToolCall[] = [];
      for await (const ev of streamTurn(this.config, this.history, {
        signal: opts?.signal,
        tools: opts?.tools,
      })) {
        if (ev.type === "text") {
          roundText += ev.delta;
          onChunk(ev.delta);
        } else if (ev.type === "reasoning") {
          onReasoning(ev.delta);
        } else {
          toolCalls = ev.toolCalls;
        }
      }
      fullText += roundText;
      this.history.push({
        role: "assistant",
        content: roundText || null,
        ...(toolCalls.length ? { toolCalls } : {}),
      });
      if (toolCalls.length === 0) return { text: fullText, called };

      let hitTerminal = false;
      for (const tc of toolCalls) {
        called.push(tc.name);
        const tool = opts?.tools?.find((t) => t.name === tc.name);
        let result: string;
        if (!tool) {
          result = `错误：未知工具 ${tc.name}`;
        } else {
          try {
            result = JSON.stringify((await tool.run(tc.args)) ?? { ok: true });
            hitTerminal ||= opts?.terminal?.includes(tc.name) ?? false;
          } catch (e) {
            result = `错误：${e instanceof Error ? e.message : String(e)}`;
          }
        }
        this.history.push({ role: "tool", toolCallId: tc.id, content: result });
      }
      if (hitTerminal) return { text: fullText, called };
    }
    return { text: fullText, called };
  }

  /** 一步对话（玩家 agent、连接测试用）。底层走流式，正文/思维链可经回调实时取出。 */
  async step(
    userInput: string,
    opts?: {
      signal?: AbortSignal;
      onText?: (delta: string) => void;
      onReasoning?: (delta: string) => void;
    },
  ): Promise<string> {
    this.history.push({ role: "user", content: userInput });
    let text = "";
    for await (const ev of streamTurn(this.config, this.history, { signal: opts?.signal })) {
      if (ev.type === "text") {
        text += ev.delta;
        opts?.onText?.(ev.delta);
      } else if (ev.type === "reasoning") {
        opts?.onReasoning?.(ev.delta);
      }
    }
    this.history.push({ role: "assistant", content: text });
    return text;
  }

  reset(systemPrompt?: string): void {
    this.history = [];
    if (systemPrompt !== undefined) {
      this.history.push({ role: "system", content: systemPrompt });
    }
  }
}
