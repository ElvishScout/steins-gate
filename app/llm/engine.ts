import { Agent } from "./agent";
import { createGmTools, freshInternals, snapshot, type GmInternals } from "./gm-tools";
import { buildGmPrompt } from "./prompts/gm";
import type { Ending, GameSetup, GmDebugEvent, GmState, LLMConfig, Scene } from "./types";

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
  /** 调试事件流（思维链片段、工具调用；按真实发生顺序）。「展示隐藏状态」模式的数据来源 */
  onDebug?: (ev: GmDebugEvent) => void;
}

/**
 * 对局引擎：状态的权威持有者，但不管节奏——GM 是一个 Claude Code 式的通用 agent，
 * 叙事走流式正文，状态操作全部走工具；规则编码在工具的校验与报错里（环境物理），
 * GM 在 agentic loop 里从报错中自我纠正。玩家输入经 present_options 的挂起-恢复注入。
 */
export class GameEngine {
  private gm: Agent | null = null;
  private internals: GmInternals = freshInternals("standard");
  private aborter: AbortController | null = null;
  private cancelInput: ((e: Error) => void) | null = null;

  constructor(private gmConfig: LLMConfig) {}

  get state(): GmState {
    return this.internals.state;
  }

  async play(setup: GameSetup, hooks: EngineHooks): Promise<void> {
    this.aborter = new AbortController();
    const signal = this.aborter.signal;
    this.internals = freshInternals(setup.difficulty);

    // 累积当前场景的正文：present_options 挂起时切一片给 onScene，然后清零重新攒
    let sceneText = "";
    const onChunk = (d: string) => {
      sceneText += d;
      hooks.onChunk(d);
    };

    const tools = createGmTools(this.internals, (options) => {      // 工具物理：没有正文的场景不许递交（工具先行的模型会把正文推到下一幕，全程错位）
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
    }, hooks.onDebug);
    this.gm = new Agent(this.gmConfig, buildGmPrompt(setup), "gm");

    let input =
      `${snapshot(this.internals)}\n` +
      `[引擎] 开局指令：\n` +
      `1. （可选）若开局设定涉及故事内时空干涉/跨线感知或第四面墙元叙事，先调用 load_skill 加载 reading-steiner 或 fourth-wall。\n` +
      `2. 调用 define_checkpoints 定义本收束范围的 4~6 个检查点（前中期节点为可延后或变形的「过程支点」，最后一个节点为整条收束范围锁死的「终极吸引子」；写明 upstream 上游依赖与 conditions 承重条件，标注 cognition/fact；至多 1 个纯 cognition 节点，建议将链尾设为纯 cognition 或「cognition + 可由前期伏笔置换的 fact」复合窄门）。\n` +
      `3. 直接写出第 1 幕小说正文：以克制、有生活质感的小说笔法自然切入场景与人物，不写"题材/主角/基调"等元信息标签，不生造突兀的危机或惊悚悬念，在顺理成章的行动节点处收笔。\n` +
      `4. 调用 present_options 递交 2~4 个自然、有区分度且顺序随机打乱的行动选项，等待玩家行动。`;
    try {
      for (let stalls = 0; !this.internals.ending; ) {
        this.internals.options = null;
        await this.gm.runTurn(input, {
          tools,
          onChunk,
          onReasoning: (d) => hooks.onDebug?.({ type: "reasoning", text: d }),
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
        input = sceneText.trim()
          ? // 正文已流出但未交选项：提示的重点是"该交选项了"，不禁止写完（可能正被打断在半段）
            `${snapshot(this.internals)}\n[引擎] 回合未完成：本幕正文已输出，请立即调用 present_options 将选择权交给玩家（若故事已至终局则调用 declare_ending）。`
          : `${snapshot(this.internals)}\n[引擎] 回合未完成：请按顺序继续——先调用 settle 结算本幕行动（若尚未结算），再输出本幕小说正文，最后调用 present_options 将选择权交给玩家（若故事已至终局则调用 declare_ending）。`;
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
