import { Agent } from "./agent";
import { createGmTools, freshInternals, snapshot, type GmInternals } from "./gm-tools";
import { barrierOf, buildGmPrompt } from "./prompts/gm";
import type { Ending, GameSetup, GmState, LLMConfig, Scene } from "./types";

/** GM 整局跑在一条 agent 循环里，轮数上限要给足（每幕约 2~4 轮工具调用）。 */
const GM_MAX_ROUNDS = 300;
/** 连续中断（模型不调工具直接收工）的容忍次数 */
const MAX_STALLS = 3;

export interface EngineHooks {
  /** GM 正文的流式增量 */
  onChunk: (delta: string) => void;
  /**
   * 场景边界：GM 已递交选项、游戏挂起。实现方负责展示选项并返回玩家行动文本——
   * 人类玩家 = 等 UI 输入的 promise；观战模式 = 喂给玩家 agent。引擎不关心对面是谁。
   */
  onScene: (scene: Scene) => Promise<string>;
  /** 终局（declare_ending 后调用，play 随即返回） */
  onEnding: (ending: Ending, state: GmState) => void;
}

/**
 * 对局引擎：状态的权威持有者，但不管节奏——GM 是一个 Claude Code 式的通用 agent，
 * 叙事走流式正文，状态操作全部走工具；规则编码在工具的校验与报错里（环境物理），
 * GM 在 agentic loop 里从报错中自我纠正。玩家输入经 present_options 的挂起-恢复注入。
 */
export class GameEngine {
  private gm: Agent | null = null;
  private internals: GmInternals = freshInternals(1);
  private aborter: AbortController | null = null;
  private cancelInput: ((e: Error) => void) | null = null;

  constructor(private gmConfig: LLMConfig) {}

  get state(): GmState {
    return this.internals.state;
  }

  async play(setup: GameSetup, hooks: EngineHooks): Promise<void> {
    this.aborter = new AbortController();
    const signal = this.aborter.signal;
    this.internals = freshInternals(barrierOf(setup.difficulty));

    // 累积当前场景的正文：present_options 挂起时切一片给 onScene，然后清零重新攒
    let sceneText = "";
    const onChunk = (d: string) => {
      sceneText += d;
      hooks.onChunk(d);
    };

    const tools = createGmTools(this.internals, (options) => {
      // 工具物理：没有正文的场景不许递交（工具先行的模型会把正文推到下一幕，全程错位）
      if (!sceneText.trim()) {
        throw new Error(
          "本幕还没有叙事正文：先输出正文（会流式展示给玩家），再递交选项。玩家只能通过正文了解故事。",
        );
      }
      return new Promise<string>((resolve, reject) => {
        this.cancelInput = reject;
        const scene: Scene = {
          act: this.internals.state.act,
          narration: sceneText.trim(),
          options,
          state: { ...this.internals.state },
        };
        sceneText = "";
        hooks.onScene(scene).then(
          (action) => {
            this.cancelInput = null;
            resolve(action);
          },
          (e) => {
            this.cancelInput = null;
            reject(e);
          },
        );
      });
    });
    this.gm = new Agent(this.gmConfig, buildGmPrompt(setup), "gm");

    let input =
      `[引擎] 开局：define_checkpoints 定义本收束范围的 4~6 个检查点（连成一条因果链：每个节点写上游依赖 ⇐ 先前节点，` +
      `逐条写承重条件并标注 cognition/fact；至多 1 个纯 cognition 节点，放链尾或弱下游作为欺骗窄门）` +
      `→ 写开场白与第 1 幕正文（开场白只确认题材与基调，反辅助条款从第一行起生效）→ present_options 等待玩家行动。`;
    try {
      for (let stalls = 0; !this.internals.ending; ) {
        this.internals.options = null;
        await this.gm.runTurn(input, {
          tools,
          onChunk,
          signal,
          maxRounds: GM_MAX_ROUNDS,
          terminal: ["declare_ending"],
        });
        if (this.internals.ending) break;
        if (this.internals.options !== null) {
          stalls = 0; // 有进展（递交过选项），重置中断计数
        } else if (++stalls > MAX_STALLS) {
          throw new Error("GM 连续多次未递交选项就中断了回合，无法继续对局");
        }
        input =
          `${snapshot(this.internals)}\n[引擎] 游戏中断：请继续——叙事、结算，然后用 ` +
          `present_options 把选择权交还玩家（故事终结则用 declare_ending）。`;
      }
    } catch (e) {
      if (signal.aborted) return; // stop() 主动中止，安静收场
      throw e;
    }
    const ending = this.internals.ending;
    if (ending) hooks.onEnding(ending, { ...this.internals.state });
  }

  stop(): void {
    this.cancelInput?.(new Error("已停止"));
    this.aborter?.abort();
  }
}
