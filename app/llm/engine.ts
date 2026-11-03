import { Agent } from "./agent";
import { createGmTools, freshInternals, snapshot, type GmInternals } from "./gm-tools";
import { buildGmPrompt, buildKickoffPrompt } from "./prompts/gm";
import { buildSetupPrompt, buildSetupUserMessage, createSetupTools } from "./prompts/setup";
import type { ChatMessage, Checkpoint, Ending, GameSetup, GmDebugEvent, GmState, LLMConfig, Scene } from "./types";

/** GM 整局跑在一条 agent 循环里，轮数上限要给足（每幕约 2~4 轮工具调用）。 */
const GM_MAX_ROUNDS = 300;
/** 连续中断（模型不调工具直接收工）的容忍次数 */
const MAX_STALLS = 3;

export interface EngineHooks {
  /** GM 正文的流式增量 */
  onText: (delta: string) => void;
  /** 场景边界：GM 已产出正文并递交选项 */
  onScene: (scene: Scene) => void;
  /** 请求玩家对当前场景做出行动（人类玩家 = 等 UI 输入；观战模式 = 玩家 agent 生成） */
  onAction: (scene: Scene) => Promise<string>;
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
  private setup: GameSetup = { difficulty: "standard" };
  private internals: GmInternals = freshInternals("standard");
  private aborter: AbortController | null = null;
  private cancelInput: ((e: Error) => void) | null = null;
  /** 当前幕正在累积的正文与结算需求标记（跨 retry 保存） */
  private sceneText = "";
  private needSettle = false;
  /** 最近一次稳定边界的快照，供请求失败/手动中断后重试恢复 */
  private checkpoint: {
    internals: GmInternals;
    history: ChatMessage[];
    needSettle: boolean;
    /** 若非空，说明快照停在 present_options 挂起等待玩家行动处（重试时需先获取玩家行动再推进 GM） */
    pending?: { toolCallId: string; scene: Scene };
  } | null = null;

  constructor(private gmConfig: LLMConfig) {}

  updateConfig(config: LLMConfig): void {
    this.gmConfig = config;
    if (this.gm) this.gm.config = config;
  }

  /** 当前局的设定（经开局 setup 子代理扩充后的版本） */
  get currentSetup(): GameSetup {
    return this.setup;
  }

  /** 当前局 α 线的初始检查点备份（供「再开一周目」复用） */
  get initialCheckpoints(): Checkpoint[] {
    return this.internals.initialCheckpoints;
  }

  get signal(): AbortSignal | undefined {
    return this.aborter?.signal;
  }

  get isEnded(): boolean {
    return Boolean(this.internals.ending);
  }

  /** 是否存在可重试的未完成回合 */
  get canRetry(): boolean {
    return this.gm !== null && this.checkpoint !== null && !this.internals.ending;
  }

  private saveCheckpoint(pending?: { toolCallId: string; scene: Scene }): void {
    if (!this.gm) return;
    this.checkpoint = {
      internals: structuredClone(this.internals),
      history: structuredClone(this.gm.history),
      needSettle: this.needSettle,
      ...(pending ? { pending: structuredClone(pending) } : {}),
    };
  }

  private waitForAction(scene: Scene, hooks: EngineHooks): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.cancelInput = reject;
      hooks.onAction(scene).then(
        (action) => {
          this.cancelInput = null;
          this.needSettle = true;
          resolve(action);
        },
        (e) => {
          this.cancelInput = null;
          const err = e instanceof Error ? e : new Error(String(e));
          (err as { fatal?: boolean }).fatal = true;
          reject(err);
        },
      );
    });
  }

  async play(setup: GameSetup, hooks: EngineHooks, initialCheckpoints?: Checkpoint[]): Promise<void> {
    this.setup = { ...setup };
    this.internals = freshInternals(setup.difficulty, initialCheckpoints);
    this.sceneText = "";
    this.needSettle = false;
    this.gm = new Agent(this.gmConfig, buildGmPrompt(this.setup));
    if (initialCheckpoints && initialCheckpoints.length > 0) {
      this.gm.history.push({
        role: "user",
        content: buildKickoffPrompt(this.setup, snapshot(this.internals), true),
      });
    }
    this.saveCheckpoint();
    await this.runLoop(hooks);
  }

  /** 从最近一次稳定边界恢复状态并重新发起未完成的回合 */
  async retry(hooks: EngineHooks): Promise<void> {
    if (!this.gm || !this.checkpoint) return;
    this.aborter = new AbortController();
    this.internals = structuredClone(this.checkpoint.internals);
    this.gm.history = structuredClone(this.checkpoint.history);
    this.needSettle = this.checkpoint.needSettle;
    this.sceneText = "";
    await this.runLoop(hooks);
  }

  private async runLoop(hooks: EngineHooks): Promise<void> {
    if (!this.gm) return;
    if (!this.aborter || this.aborter.signal.aborted) {
      this.aborter = new AbortController();
    }
    const signal = this.aborter.signal;

    // 累积当前场景的正文：present_options 挂起时切一片给 onScene，然后清零重新攒。
    // 在本幕必调工具（开局/跃迁后的 define_checkpoints、常规幕的 settle）执行完毕前，
    // 模型抢跑吐出的正文（如 grok 4.7 习惯先吐一段话再调工具）转为思考过程展示，不计入 sceneText
    // 也不发给玩家；但 Agent 内部仍按 assistant content 记入历史并在后续轮次原样送回。
    const readyToNarrate = () =>
      (!this.needSettle || this.internals.settledThisAct) &&
      (this.internals.actsThisLine > 0 || this.internals.state.checkpoints.some((c) => c.status === "pending"));
    const onText = (d: string) => {
      if (!readyToNarrate()) {
        hooks.onDebug?.({ type: "reasoning", text: d });
        return;
      }
      this.sceneText += d;
      hooks.onText(d);
    };

    const tools = createGmTools(
      this.internals,
      (options) => {
        // 工具物理：没有正文的场景不许递交（工具先行的模型会把正文推到下一幕，全程错位）
        if (!this.sceneText.trim()) {
          throw new Error("本幕还没有叙事正文：先输出正文（会流式展示给玩家），再递交选项。玩家只能通过正文了解故事。");
        }
        // 工具事件在挂起前发出：挂起即场景边界，之后发出会错位到下一幕的附注
        hooks.onDebug?.({ type: "tool", name: "present_options", args: { options } });
        const scene: Scene = {
          act: this.internals.state.act,
          narration: this.sceneText.trim(),
          options,
          state: structuredClone(this.internals.state),
        };
        this.sceneText = "";
        hooks.onScene(scene);
        // 场景已展示给用户：保存场景边界快照，若在等待玩家（或观战玩家 agent）行动期间被停止，重试时不必重跑本幕 GM
        const lastMsg = this.gm?.history[this.gm.history.length - 1];
        const tcId =
          lastMsg?.role === "assistant"
            ? lastMsg.toolCalls?.find((tc) => tc.name === "present_options")?.id
            : undefined;
        if (tcId) {
          this.saveCheckpoint({ toolCallId: tcId, scene });
        }
        return this.waitForAction(scene, hooks);
      },
      hooks.onDebug,
    );

    let input: string | null = null;
    try {
      // 开局尚未注入首条 user 消息时，先由轻量 setup agent 按需调 roll_inspiration 并通过 submit_setup 工具写回设定
      if (!this.gm.history.some((message) => message.role === "user")) {
        const setupAgent = new Agent(this.gmConfig, buildSetupPrompt());
        await setupAgent.runTurn(buildSetupUserMessage(this.setup), {
          tools: createSetupTools(this.setup, hooks.onDebug),
          onText: (d) => hooks.onDebug?.({ type: "reasoning", text: d }),
          onReasoning: (d) => hooks.onDebug?.({ type: "reasoning", text: d }),
          signal,
          terminal: ["submit_setup"],
        });
        this.gm.history.push({
          role: "user",
          content: buildKickoffPrompt(this.setup, snapshot(this.internals)),
        });
        this.saveCheckpoint();
      }

      // 若从等待玩家行动的检查点恢复（重试），先补完玩家行动并写入 tool 结果，再推进 GM
      if (this.checkpoint?.pending) {
        const { toolCallId, scene } = this.checkpoint.pending;
        const action = await this.waitForAction(scene, hooks);
        this.internals.options = scene.options;
        this.internals.settledThisAct = false;
        this.internals.definedCheckpointsThisAct = false;
        this.gm.history.push({
          role: "tool",
          toolCallId,
          content: `${snapshot(this.internals)}\n[玩家行动] ${action}`,
        });
        this.saveCheckpoint();
      }

      for (let stalls = 0; !this.internals.ending;) {
        this.internals.options = null;
        await this.gm.runTurn(input, {
          tools,
          onText,
          onReasoning: (d) => hooks.onDebug?.({ type: "reasoning", text: d }),
          signal,
          maxRounds: GM_MAX_ROUNDS,
          terminal: ["declare_ending"],
          onToolResult: (name) => {
            if (name === "present_options" && this.internals.options !== null) {
              this.saveCheckpoint();
            }
          },
        });
        if (this.internals.ending) break;
        if (this.internals.options !== null) {
          stalls = 0; // 有进展（递交过选项），重置中断计数
        } else if (++stalls > MAX_STALLS) {
          throw new Error("GM 连续多次未递交选项就中断了回合，无法继续对局");
        }
        input = this.sceneText.trim()
          ? // 正文已流出但未交选项：提示的重点是"该交选项了"，不禁止写完（可能正被打断在半段）
            `${snapshot(this.internals)}\n[引擎] 回合未完成：本幕正文已输出，请立即调用 present_options 将选择权交给玩家（若故事已至终局则调用 declare_ending）。`
          : this.internals.state.checkpoints.length === 0
            ? `${snapshot(this.internals)}\n[引擎] 回合未完成：请继续——先调用 define_checkpoints 定义本收束范围的 4~6 个检查点，再输出本幕小说正文，最后调用 present_options 将选择权交给玩家。`
            : `${snapshot(this.internals)}\n[引擎] 回合未完成：请按顺序继续——先调用 settle 结算本幕行动（若尚未结算），再输出本幕小说正文，最后调用 present_options 将选择权交给玩家（若故事已至终局则调用 declare_ending）。`;
      }
    } catch (e) {
      if (signal.aborted) return; // stop() 主动中止，安静收场
      throw e;
    }
    const ending = this.internals.ending;
    if (ending) {
      this.checkpoint = null;
      hooks.onEnding(ending, structuredClone(this.internals.state));
    }
  }

  stop(): void {
    this.cancelInput?.(new Error("已停止"));
    this.aborter?.abort();
  }
}
