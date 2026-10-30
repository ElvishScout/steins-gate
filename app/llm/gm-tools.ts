import type { AgentTool } from "./agent";
import { barrierOf, GM_SKILLS, profileOf, type GmSkillId } from "./prompts/gm";
import type { Checkpoint, Contradiction, ContradictionMagnitude, Difficulty, GmDebugEvent, GmState } from "./types";

/** 矛盾量级档位 → 合法幅度区间（百分点，取绝对值）。restorative 为负方向。 */
const TIER_RANGES: Record<string, [number, number]> = {
  subtle: [0.001, 0.01], // 细微矛盾：善缘/伏笔/后手/细节错位（收束范围内分支移动）
  notable: [0.01, 0.05], // 显著矛盾：动摇检查点非承重环节
  fundamental: [0.1, 0.3], // 根本矛盾：斩断/替代承重条件——唯一参与跳线判定的量级
  restorative: [0.01, 0.1], // 修复性行动：消解已有矛盾（负）
  free: [0, 0.6], // 自由输入：可突破上限（奇思妙想值得奖励）
};

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/**
 * 节奏物理：一条收束范围的预期长度 = 4~6 检查点 × 至少隔 2 幕 ≈ 8~18 幕。
 * 软上限后在 settle 返回里持续催推进；硬上限后 present_options 拒绝再开新场景；
 * 全局极限幕数后只剩 declare_ending 一条路。防止对局无限发散。
 */
const SOFT_ACTS_PER_LINE = 20;
const HARD_ACTS_PER_LINE = 30;
const MAX_TOTAL_ACTS = 60;

/** 自由输入的矛盾量级由幅度推定（自由输入只是来源，账本上只记三种量级）。 */
function magnitudeOf(tier: string, absDelta: number): ContradictionMagnitude | null {
  if (tier === "subtle" || tier === "notable" || tier === "fundamental") return tier;
  if (tier !== "free") return null; // restorative 不产生新矛盾
  if (absDelta <= 0.01) return "subtle";
  if (absDelta <= 0.05) return "notable";
  return "fundamental";
}

/**
 * 跳线判定（引擎物理）：跳线的唯一条件是矛盾，不是读数。
 * 未消化的根本矛盾积累到因果链无法自洽（通常 2 个起），或一次直接击穿
 * 核心节点（breach），或贴线脆弱状态（读数在当前 1% 区间内达到 fragileRatio）下仅需 1 个。
 * 细微/显著矛盾无论积累多少都永不触发跃迁。
 */
export function jumpReadiness(
  s: GmState,
  fragileRatio = 0.8,
): {
  ready: boolean;
  activeFundamental: number;
  fragile: boolean;
  breach: boolean;
} {
  const fund = s.contradictions.filter((c) => c.status === "active" && c.magnitude === "fundamental");
  // 每个世界线收束范围区间宽度恒为 1%（[barrier - 1, barrier)），脆弱阈值按当前区间进度计算
  const lower = Math.max(0, Math.round(s.barrier) - 1);
  const fragile = s.divergence >= round6(lower + fragileRatio);
  const breach = fund.some((c) => c.breach);
  return {
    ready: fund.length >= 2 || (fragile && fund.length >= 1) || breach,
    activeFundamental: fund.length,
    fragile,
    breach,
  };
}

/** 引擎持有的 GM 侧内部状态：权威数值 + 本幕工具调用的捕获位。 */
export interface GmInternals {
  state: GmState;
  /** 当前难度的贴线脆弱阈值（当前 1% 区间内的占比，如 0.75 / 0.80 / 0.90） */
  fragileRatio: number;
  /** 本局已加载的专题规则模块 */
  loadedSkills: Set<GmSkillId>;
  /** 本幕是否已结算（settle 幂等约束；present_options/declare_ending 成功时复位） */
  settledThisAct: boolean;
  /** 本幕是否刚调用过 define_checkpoints（防止建好新检查点当幕就触发掉；present_options 成功时复位） */
  definedCheckpointsThisAct: boolean;
  /** 开局首个收束范围（α 线）的初始检查点备份，供「再开一周目」直接复用 */
  initialCheckpoints: Checkpoint[];
  /** 当前收束范围已进行的幕数（节奏判定用；跃迁时清零，state.act 是全剧累计不清零） */
  actsThisLine: number;
  /** present_options 捕获的本幕选项 */
  options: string[] | null;
  /** declare_ending 捕获的结局 */
  ending: { tier: string; title: string; yearbook: string } | null;
}

export function freshInternals(
  difficulty: Difficulty = "standard",
  initialCheckpoints?: Checkpoint[],
): GmInternals {
  const profile = profileOf(difficulty);
  const [minDiv, maxDiv] = profile.initialRange;
  const initialDiv = round6(minDiv + Math.random() * (maxDiv - minDiv));
  const presetCps: Checkpoint[] = (initialCheckpoints ?? []).map(({ note: _, ...c }) => ({
    ...structuredClone(c),
    status: "pending" as const,
  }));
  return {
    state: {
      act: 0,
      worldline: "α",
      // 初始读数：按难度落在 α 线不同深浅区间（如标准难度对应 0.571024% 附近，残酷对应 0.337187% 深渊）
      divergence: initialDiv,
      barrier: barrierOf(difficulty),
      checkpoints: presetCps,
      contradictions: [],
      history: [],
      ending: null,
    },
    fragileRatio: profile.fragileRatio,
    loadedSkills: new Set(),
    settledThisAct: false,
    definedCheckpointsThisAct: presetCps.length > 0,
    initialCheckpoints: structuredClone(presetCps),
    actsThisLine: 0,
    options: null,
    ending: null,
  };
}

function clampDelta(tier: string, delta: number): { signed: number; clamped: boolean } {
  const range = TIER_RANGES[tier];
  if (!range) throw new Error(`未知档位 "${tier}"，合法值：${Object.keys(TIER_RANGES).join("/")}`);
  const sign = tier === "restorative" ? -1 : 1;
  const abs = Math.abs(delta);
  const clampedAbs = Math.min(Math.max(abs, range[0]), range[1]);
  return { signed: sign * clampedAbs, clamped: clampedAbs !== abs };
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v) throw new Error(`缺少字符串参数 ${name}`);
  return v;
};

const MAGNITUDE_LABEL: Record<ContradictionMagnitude, string> = {
  subtle: "细微",
  notable: "显著",
  fundamental: "根本",
};

/** 节奏提示（注入 settle 返回值与状态快照）：检查点迟迟不触发时催 GM 向终幕推进。 */
function pacingNote(gm: GmInternals): string {
  const pending = gm.state.checkpoints.filter((c) => c.status === "pending").length;
  if (pending === 0 || gm.actsThisLine < SOFT_ACTS_PER_LINE) return "";
  const urgent = gm.actsThisLine >= HARD_ACTS_PER_LINE - 4;
  return (
    `｜节奏${urgent ? "警告" : "提示"}：本收束范围已进行 ${gm.actsThisLine} 幕，仍有 ${pending} 个检查点未触发。` +
    `请顺着当前人物处境与现实脉络自然收拢因果、推进检查点触发${urgent ? "，故事必须在数幕内自然步入终幕" : "，避免剧情无休止发散"}。`
  );
}

/** 注入给 GM 的隐藏状态快照（玩家永不可见），随 present_options 的结果每幕返回。 */
export function snapshot(gm: GmInternals): string {
  const s = gm.state;
  const cps =
    s.checkpoints
      .map((c) => {
        const conds = c.conditions.map((x) => `${x.condition}[${x.via}]`).join("、");
        const up = c.upstream.length ? `⇐${c.upstream.join("+")}` : "⇐无";
        return `${c.id}[${c.status}]${up} ${c.content}｜承重：${conds}${c.note ? `（${c.note}）` : ""}`;
      })
      .join("；") || "（未定义）";
  const cons =
    s.contradictions
      .filter((c) => c.status === "active")
      .map(
        (c) =>
          `${c.id}[${MAGNITUDE_LABEL[c.magnitude]}${c.breach ? "·击穿" : ""}]${c.text}` +
          `${c.related ? `（关联${c.related}）` : ""}`,
      )
      .join("；") || "（空）";
  const jr = jumpReadiness(s, gm.fragileRatio);
  return (
    `[内部状态快照] 第${s.act}幕（本线第${gm.actsThisLine}幕） 世界线=${s.worldline} ` +
    `变动率=${s.divergence.toFixed(6)}% ` +
    `壁垒=${s.barrier.toFixed(6)}%${jr.fragile ? "（贴线脆弱）" : ""} 检查点=${cps} ` +
    `未消化矛盾=${cons}｜未消化根本矛盾×${jr.activeFundamental} ` +
    `跳线判定=${jr.ready ? "就绪（应跃迁）" : "不就绪"}${pacingNote(gm)}`
  );
}

export function createGmTools(
  gm: GmInternals,
  /** present_options 调用后挂起等待的来源：玩家的行动文本（人或 agent 提供） */
  requestInput: (options: string[]) => Promise<string>,
  /** 调试事件出口（「展示隐藏状态」模式）：每次工具执行后发出，带执行后状态快照 */
  notify?: (ev: GmDebugEvent) => void,
): AgentTool[] {
  /** 包装工具：执行成功/报错后向 UI 发出工具事件。present_options 的成功事件在挂起前手动发出（挂起即场景边界）。 */
  const withNotify = (tool: AgentTool): AgentTool => {
    if (!notify) return tool;
    return {
      ...tool,
      async run(args) {
        try {
          const result = await tool.run(args);
          if (tool.name !== "present_options") {
            notify({ type: "tool", name: tool.name, args, state: structuredClone(gm.state) });
          }
          return result;
        } catch (e) {
          notify({
            type: "tool",
            name: tool.name,
            args,
            state: structuredClone(gm.state),
            error: e instanceof Error ? e.message : String(e),
          });
          throw e;
        }
      },
    };
  };
  const tools: AgentTool[] = [
    {
      name: "settle",
      description:
        "结算玩家本回合行动制造或消解的矛盾，记入唯一隐藏账本（矛盾清单）。每幕必须且只能调用一次，且应在输出本幕小说正文之前调用。tier 表示行动实际后果与既定因果链的偏离程度：subtle 细微矛盾（日常可消化的偏差：结下善缘、埋下伏笔、留后手、行程错位——不改写世界线，但会作为伏笔沉淀并影响终局）/ notable 显著矛盾（动摇检查点的外围非承重环节）/ fundamental 根本矛盾（直接斩断或改写检查点的承重条件——唯一参与跳线判定的量级）/ restorative 修复性行动（主动消解既有矛盾、顺应或修复主干因果，读数回落）/ free 自由输入（按分级标准裁定，精妙行动可突破常规上限）。delta 为幅度绝对值（百分点，使用带随机尾数的六位小数如 0.017392）。细微与显著矛盾无论积累多少都永不触发跃迁，读数最多逼近壁垒内侧。",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "玩家行动及其直接后果的一句话概括" },
          tier: { type: "string", enum: Object.keys(TIER_RANGES) },
          delta: { type: "number", description: "幅度绝对值（六位小数，如 0.027436）" },
          related: { type: "string", description: "关联的检查点 id（该行动所铺垫、试探或对抗的节点）" },
          breach: {
            type: "boolean",
            description:
              "本次行动是否直接击穿某个检查点的核心承重条件（仅 fundamental/free 可为 true，单次即可撕裂因果链）",
          },
          digests: {
            type: "array",
            items: { type: "string" },
            description: "restorative 专用：本行动消解的既有矛盾 id 列表",
          },
          note: { type: "string", description: "结算备注（因果如何自然延展或收束、伏笔性质等）" },
        },
        required: ["summary", "tier", "delta"],
      },
      run(args) {
        if (gm.settledThisAct) {
          throw new Error("本幕已经结算过（每幕仅一次）。若对刚才的结算不满意，下一幕用 restorative 档修正。");
        }
        const tier = str(args.tier, "tier");
        const delta = typeof args.delta === "number" ? args.delta : NaN;
        if (Number.isNaN(delta)) throw new Error("delta 必须是数字");
        const { signed, clamped } = clampDelta(tier, delta);
        const s = gm.state;

        // 记入/消解矛盾清单
        let entry: Contradiction | null = null;
        const magnitude = magnitudeOf(tier, Math.abs(signed));
        if (magnitude) {
          entry = {
            id: `C${s.contradictions.length + 1}`,
            act: s.act + 1,
            text: str(args.summary, "summary"),
            magnitude,
            delta: signed,
            ...(typeof args.related === "string" && args.related ? { related: args.related } : {}),
            status: "active",
            ...(typeof args.note === "string" && args.note ? { note: args.note } : {}),
          };
          if (args.breach === true) {
            if (magnitude !== "fundamental") {
              throw new Error("breach（直接击穿核心节点）只适用于根本矛盾量级的行动。");
            }
            entry.breach = true;
          }
          s.contradictions.push(entry);
        }
        if (tier === "restorative") {
          const ids = Array.isArray(args.digests) ? (args.digests as string[]) : [];
          for (const id of ids) {
            const c = s.contradictions.find((x) => x.id === id);
            if (!c) throw new Error(`找不到矛盾 ${id}`);
            if (c.status === "active") c.status = "digested";
          }
        }

        // 更新读数：任何档位都只能逼近壁垒而不越线——跃迁表现为读数越过壁垒，
        // 但跳线的唯一条件是矛盾（见 jump_worldline），读数本身不是条件
        let next = round6(s.divergence + signed);
        let blockedAtBarrier = false;
        if (next >= s.barrier) {
          next = round6(s.barrier - 0.000001);
          blockedAtBarrier = true;
        }
        if (next < 0) next = 0;
        s.divergence = next;
        s.act += 1;
        gm.actsThisLine += 1;
        gm.settledThisAct = true;
        s.history.push(
          `第${s.act}幕结算：${str(args.summary, "summary")}（${tier} ${signed >= 0 ? "+" : ""}${round6(signed)}% → ${next.toFixed(6)}%）${entry ? `｜记矛盾 ${entry.id}[${MAGNITUDE_LABEL[entry.magnitude]}]` : ""}${typeof args.note === "string" ? `｜${args.note}` : ""}`,
        );
        const jr = jumpReadiness(s, gm.fragileRatio);
        const pacing = pacingNote(gm);
        return {
          divergence: s.divergence,
          worldline: s.worldline,
          barrier: s.barrier,
          clamped,
          blockedAtBarrier,
          activeFundamental: jr.activeFundamental,
          fragile: jr.fragile,
          jumpReady: jr.ready,
          message:
            (jr.ready
              ? "未消化的根本矛盾已撕裂因果链！请先调用 jump_worldline 完成跃迁，并调用 define_checkpoints 重建新收束范围的检查点，随后再输出本幕小说正文（跃迁在叙事中应无痕衔接，不写时空异象）。"
              : blockedAtBarrier
                ? "读数已贴在壁垒内侧（贴线脆弱状态）。细微/显著矛盾不会直接触发跳线；后续只需 1 个未消化的根本矛盾即可击穿壁垒，或引导玩家在含 cognition 条件的检查点上凭伏笔尝试欺骗世界。"
                : "结算完成。请顺着人物性格与现实脉络写出本幕小说正文，再调用 present_options。") + pacing,
        };
      },
    },
    {
      name: "define_checkpoints",
      description:
        "定义当前收束范围的 4~6 个检查点（开局或跃迁后调用；复杂或长线题材宜定满 5~6 个，将中段各阶段的因果波折拆分为独立支点）。检查点构成世界线收束范围的双层结构：前中期节点为『过程支点』（允许玩家通过行动使其延后、变形或局部改写，体现阶段性改变感），最后一个节点为『最终收束点』（整条收束范围锁死的因果终点，前中期所有偏折最终在此合围）。所有检查点均代表接下来待经历的节点，已发生的开场或跃迁背景不占检查点名额。每个节点需写明：1. upstream（上游依赖：承接哪些先前节点的因果，首节点为空数组）；2. conditions（承重条件：因果链断在哪一环就接不上），每条标注传导方式——cognition 经由特定观测者的持续主观认知（唯有让该观测者始终确信表象并继续履行下游因果，才可通过场面调度与信息差伪造），fact 经由客观事实（不可靠演戏伪造，但允许玩家调动前中期埋下的矛盾伏笔，以真实物理或现实手段提前置换或促成，即『金属乌帕』式伏笔）。每收束范围至多 1 个『全部条件均为 cognition』的节点；若最终收束点承担的是迫使主角跃迁的客观死局则设为纯 fact 节点，仅在节点因果真正取决于特定观测表象时才设为可欺骗节点。",
      parameters: {
        type: "object",
        properties: {
          checkpoints: {
            type: "array",
            minItems: 4,
            maxItems: 6,
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: {
                  type: "string",
                  description:
                    "节点的显现事件及其撬动的下游因果功能（格式：事件表象——它导致的下游处境、关系或局势转折）",
                },
                upstream: {
                  type: "array",
                  items: { type: "string" },
                  description: "上游依赖：本节点承接哪些先前节点撬动的因果（id 列表；首节点为空数组）",
                },
                conditions: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    properties: {
                      condition: {
                        type: "string",
                        description: "该节点得以成立的具体承重条件（即因果链不能断裂的关键一环）",
                      },
                      via: { type: "string", enum: ["cognition", "fact"] },
                    },
                    required: ["condition", "via"],
                  },
                },
              },
              required: ["id", "content", "upstream", "conditions"],
            },
          },
        },
        required: ["checkpoints"],
      },
      run(args) {
        if (gm.state.act === 0 && gm.initialCheckpoints.length > 0 && gm.state.checkpoints.length > 0) {
          return {
            ok: true,
            count: gm.state.checkpoints.length,
            message:
              "本局已继承初始检查点因果链，无需重复定义。请继续思考并写出第 1 幕小说正文，随后调用 present_options 将选择权交给玩家。",
          };
        }
        const list = args.checkpoints;
        if (!Array.isArray(list) || list.length < 4 || list.length > 6) {
          throw new Error("检查点必须是 4~6 个，连成一条因果链。");
        }
        const seen = new Set<string>();
        for (const c of list as Checkpoint[]) {
          if (!Array.isArray(c.upstream)) {
            throw new Error(
              `检查点 ${c.id} 缺少 upstream：每个节点都要写上游依赖（首节点为空数组）——没有上游，这个节点就不会存在。`,
            );
          }
          for (const up of c.upstream) {
            if (!seen.has(up)) {
              throw new Error(`检查点 ${c.id} 的上游 "${up}" 不是它之前的节点：因果链只能承接先前节点撬动的因果。`);
            }
          }
          if (!Array.isArray(c.conditions) || c.conditions.length === 0) {
            throw new Error(`检查点 ${c.id} 没有承重条件：每个节点至少写一条"这条因果链断在哪就接不上"。`);
          }
          seen.add(c.id);
        }
        const pureCognition = (list as Checkpoint[]).filter((c) => c.conditions.every((x) => x.via === "cognition"));
        if (pureCognition.length > 1) {
          throw new Error(
            "每个收束范围至多 1 个'全部承重条件均为 cognition'的检查点（宜放在链尾或弱下游，作为通往命运石之门线结局的突破口），请重发。",
          );
        }
        gm.state.checkpoints = structuredClone(list as Omit<Checkpoint, "status">[]).map((c) => ({
          ...c,
          status: "pending" as const,
        }));
        if (gm.initialCheckpoints.length === 0) {
          gm.initialCheckpoints = structuredClone(gm.state.checkpoints);
        }
        gm.definedCheckpointsThisAct = true;
        return {
          ok: true,
          count: gm.state.checkpoints.length,
          message:
            "检查点因果链已建立（新定义的检查点代表后续待推进的节点，本幕不可立即调用 update_checkpoint 触发）。请继续思考并写出本幕小说正文，随后调用 present_options 将选择权交给玩家。",
        };
      },
    },
    {
      name: "update_checkpoint",
      description:
        "更新检查点状态：triggered 已触发（含顺应人情事理的自然收束、路径重接，或玩家以其他真实方式主动达成该节点的因果功能）/ deceived 已成功欺骗世界（仅限玩家在知晓收束规律后主动设计欺骗方案，在让关键观测者持续确信表面结果并履行下游因果的同时，暗中改写了实质结果；正面硬拼或目标当场苏醒致观测认知瓦解的绝不可标为 deceived）/ void 作废（跃迁时由引擎自动处理）。标记 deceived 时，必须在 note 中逐条说明各承重条件如何被满足（哪位观测者如何被持续瞒过并推动下游因果、fact 条件如何被真实促成）。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["pending", "triggered", "deceived", "void"] },
          note: { type: "string", description: "触发或欺骗的具体实现过程" },
        },
        required: ["id", "status"],
      },
      run(args) {
        const cp = gm.state.checkpoints.find((c) => c.id === args.id);
        if (!cp) throw new Error(`找不到检查点 ${String(args.id)}`);
        if (gm.definedCheckpointsThisAct && (args.status === "triggered" || args.status === "deceived")) {
          throw new Error(
            `本幕刚调用 define_checkpoints 建立新检查点链，不得在同一幕内直接将新检查点 ${cp.id} 标为 ${String(args.status)}。新检查点必须留待后续回合由玩家互动推进；若某事件在跃迁落点时已然发生，请作为新世界线的开场背景描写，不要占用新检查点名额。`,
          );
        }
        if (!gm.loadedSkills.has("reading-steiner") && (args.status === "pending" || cp.status !== "pending")) {
          throw new Error(
            `检查点 ${cp.id} 当前已是 ${cp.status} 状态，常规模式下不可回溯或重置检查点。`,
          );
        }
        if (args.status === "deceived") {
          if (!cp.conditions.some((x) => x.via === "cognition")) {
            throw new Error(
              "该检查点的承重条件全部经由客观事实（fact）传导，不经过任何人的主观认知——伪造只会被现实逻辑顺势坐实为真（弄假成真、替身受过）。纯事实节点不可欺骗：请按欺骗失败处理（暴露的伏笔用 digest_contradiction 标 void 作废），或待玩家以真实手段促成其因果功能后标 triggered。",
            );
          }
          if (typeof args.note !== "string" || !args.note.trim()) {
            throw new Error(
              "标记 deceived 必须在 note 里逐条说明承重条件如何被保全：哪位关键观测者如何持续确信假象并履行下游因果（不可出现受骗观测者当场看到目标苏醒导致认知瓦解）、fact 条件如何由前期伏笔真实促成，且欺骗方案必须源于玩家的主动设局而非被动巧合。",
            );
          }
        }
        cp.status = args.status as Checkpoint["status"];
        if (typeof args.note === "string") cp.note = args.note;
        const allDone = gm.state.checkpoints.length > 0 && gm.state.checkpoints.every((c) => c.status !== "pending");
        const hasReadingSteiner = gm.loadedSkills.has("reading-steiner");
        return {
          ok: true,
          checkpoint: cp,
          ...(allDone
            ? {
                message: hasReadingSteiner
                  ? "当前收束范围的最后一个检查点已达成。若故事尚处于时间回溯、跨线抗争或化解前置因果的中途阶段，请继续递交 2~4 个分支选项（present_options）推进回溯博弈（回溯后可用 update_checkpoint 将相关节点重置回 pending）；若全剧主线已彻底走完，请调用 load_skill({ id: 'el-psy-kongroo' }) 加载终幕规范并以空选项 present_options({ options: [] }) 收束全篇。"
                  : "当前收束范围的所有检查点已尘埃落定！请调用 load_skill({ id: 'el-psy-kongroo' }) 加载终幕与年鉴规范，写出终幕正文后以空选项 present_options({ options: [] }) 交由玩家作最终回应。",
              }
            : {}),
        };
      },
    },
    {
      name: "digest_contradiction",
      description:
        "在 settle 之外单独消化或作废一条矛盾：当既有矛盾在后续发展中被世界自然吸收消解时标为消化（缺省）；当玩家欺骗世界失败、导致此前埋下的伏笔暴露失效时标为作废（void: true）。未消化的根本矛盾减少时，跳线判定随之更新。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "矛盾 id（状态快照中的 C1/C2/…）" },
          void: { type: "boolean", description: "true = 作废（欺骗失败导致伏笔暴露失效），缺省 = 自然消化" },
          note: { type: "string", description: "消化或作废的具体原因" },
        },
        required: ["id"],
      },
      run(args) {
        const c = gm.state.contradictions.find((x) => x.id === args.id);
        if (!c) throw new Error(`找不到矛盾 ${String(args.id)}`);
        if (c.status !== "active") throw new Error(`矛盾 ${c.id} 已是 ${c.status} 状态。`);
        c.status = args.void === true ? "void" : "digested";
        if (typeof args.note === "string") c.note = args.note;
        const jr = jumpReadiness(gm.state, gm.fragileRatio);
        return { ok: true, contradiction: c, activeFundamental: jr.activeFundamental, jumpReady: jr.ready };
      },
    },
    {
      name: "jump_worldline",
      description:
        "执行世界线跃迁。常规模式下仅当未消化的根本矛盾撕裂因果链（settle 或 digest_contradiction 返回 jumpReady=true）时可调用；已加载 reading-steiner 模块时，剧中人物可通过自造或掌握的时空干涉手段主动发起跃迁（不受 jumpReady 与单向递增区间限制）。调用后旧收束范围未触发的检查点自动作废，随后须调用 define_checkpoints 定义新检查点。",
      parameters: {
        type: "object",
        properties: {
          worldline: { type: "string", description: "新世界线/收束范围代号（如 α/β/γ/δ…）" },
          divergence: { type: "number", description: "跃迁后的读数（六位小数）" },
          note: { type: "string", description: "新世界线的因果基调变化备注" },
        },
        required: ["worldline", "divergence"],
      },
      run(args) {
        const s = gm.state;
        const jr = jumpReadiness(s, gm.fragileRatio);
        const hasReadingSteiner = gm.loadedSkills.has("reading-steiner");
        if (!jr.ready && !hasReadingSteiner) {
          throw new Error(
            `因果链尚可自洽，不许跃迁（未消化根本矛盾×${jr.activeFundamental}${jr.fragile ? "，贴线脆弱" : ""}）。跳线的唯一条件是矛盾：根本矛盾通常需积累 2 个以上，贴线脆弱（读数达到当前区间 ${Math.round(gm.fragileRatio * 100)}%）时 1 个即可，或直接击穿核心节点。细微/显著矛盾无论积累多少都永不跳线。`,
          );
        }
        const d = typeof args.divergence === "number" ? args.divergence : NaN;
        if (Number.isNaN(d) || d < 0) {
          throw new Error(`跃迁后的读数必须是非负数字，收到 ${String(args.divergence)}。`);
        }
        if (!hasReadingSteiner) {
          // 常规模式：区间宽度恒 1%、整数边界即壁垒，新区间 = [round(旧壁垒), round(旧壁垒)+1)
          const lower = Math.round(s.barrier);
          const upper = lower + 1;
          if (d < lower || d >= upper) {
            throw new Error(
              `跃迁后的读数必须落在新区间 [${lower.toFixed(6)}%, ${upper.toFixed(6)}%) 内，收到 ${String(args.divergence)}。`,
            );
          }
        }
        const newBarrier = Math.floor(d) + 1;
        s.worldline = str(args.worldline, "worldline");
        s.barrier = newBarrier;
        s.divergence = round6(d);
        gm.actsThisLine = 0; // 新收束范围重新开始计幕
        for (const cp of s.checkpoints) if (cp.status === "pending") cp.status = "void";
        s.history.push(
          `⚡ 跃迁至 ${s.worldline} 线（读数 ${s.divergence.toFixed(6)}%），旧检查点作废，新壁垒 ${s.barrier.toFixed(6)}%${typeof args.note === "string" ? `｜${args.note}` : ""}`,
        );
        return {
          ok: true,
          worldline: s.worldline,
          divergence: s.divergence,
          barrier: s.barrier,
          message:
            "跃迁完成。请立即调用 define_checkpoints 为新收束范围重建 4~6 个检查点（基调呼应玩家破局的方式），随后写出自然衔接的本幕小说正文。",
        };
      },
    },
    {
      name: "present_options",
      description:
        "在输出本幕小说正文之后调用，向玩家递交分支选项并挂起等待玩家行动。选项应为 2~4 个具体、合乎情理、有实质区分度的行动描述（贴合主角当下处境，如真人的自然抉择，不要写夸张的戏剧宣言）。选项池中应包含顺应局势的稳妥做法与带有试探或破局意味的做法，但每幕排列顺序必须随机打乱，严禁按『保守→激进』固定排序。当所有检查点均已触发或被欺骗、进入终幕时，传入空数组 options: []，等待玩家对整条世界线的最后自由回应。",
      parameters: {
        type: "object",
        properties: {
          options: { type: "array", items: { type: "string" }, maxItems: 4 },
        },
        required: ["options"],
      },
      async run(args) {
        if (gm.state.act >= 1 && !gm.settledThisAct) {
          throw new Error("本幕尚未结算：请先调用 settle 结算玩家上一轮行动，再输出正文并调用 present_options。");
        }
        // 节奏物理（先于一切常规校验）：故事不许无限发散
        if (gm.state.act >= MAX_TOTAL_ACTS) {
          throw new Error(
            `故事已达极限长度（${MAX_TOTAL_ACTS} 幕），不得再递交选项：请在本回合内用 update_checkpoint 让剩余检查点尘埃落定（triggered/void），然后直接调用 declare_ending 收束全篇。`,
          );
        }
        const pendingCount = gm.state.checkpoints.filter((c) => c.status === "pending").length;
        if (pendingCount > 0 && gm.actsThisLine >= HARD_ACTS_PER_LINE) {
          throw new Error(
            `本收束范围已进行 ${gm.actsThisLine} 幕（上限 ${HARD_ACTS_PER_LINE}），不得再开启新场景：请在本回合内用 update_checkpoint 让剩余 ${pendingCount} 个检查点全部尘埃落定，随后进入终幕（传入空数组调用 present_options 或直接调用 declare_ending）。`,
          );
        }
        const opts = args.options;
        // 终幕（当前收束范围没有 pending 检查点）不给分支选项：允许空选项列表
        const finale = gm.state.checkpoints.length > 0 && gm.state.checkpoints.every((c) => c.status !== "pending");
        const min = finale ? 0 : 2;
        if (!Array.isArray(opts) || opts.length < min || opts.length > 4) {
          throw new Error(finale ? "终幕可以不给选项（空数组），或最多 4 个" : "选项必须是 2~4 个字符串");
        }
        // 全部校验通过、且玩家已行动之后，才允许改状态——
        // requestInput 抛错（如本幕无正文、玩家中止）时不能留下半变更的死锁状态
        // 工具事件在挂起前发出：挂起即场景边界，之后发出会错位到下一幕的附注
        notify?.({
          type: "tool",
          name: "present_options",
          args,
          state: structuredClone(gm.state),
        });
        const action = await requestInput(opts.map(String));
        gm.options = opts.map(String);
        gm.settledThisAct = false;
        gm.definedCheckpointsThisAct = false;
        return `${snapshot(gm)}\n[玩家行动] ${action}`;
      },
    },
    {
      name: "declare_ending",
      description:
        "在终幕结算与尾声正文完成后调用，正式宣告结局并输出世界线年鉴。tier 分为：convergence（收束结局：关键节点均按既定因果触发，由细微矛盾决定结局余温）/ branch（分支结局：未跨壁垒但凭大量矛盾深刻改变了终局处境与关系）/ steins-gate（SG 线式真结局：要求至少一个检查点为 deceived，在不引发世界线崩塌的前提下改写了命运）。yearbook 为世界线年鉴全文：首次向玩家完整复盘各幕抉择、隐形收束与跃迁瞬间，并逐一回收矛盾清单中的伏笔。",
      parameters: {
        type: "object",
        properties: {
          tier: { type: "string", enum: ["convergence", "branch", "steins-gate"] },
          title: {
            type: "string",
            description:
              "结局标题（格式：「<世界线> 世界线 · <六位小数读数>% <贴合故事意境的副标题>」，其中世界线代号与读数须与当前真实状态一致；仅在达成 steins-gate 真结局且已跨入目标区间时可定格为 1.048596%）",
          },
          yearbook: { type: "string", description: "世界线年鉴全文（复盘关键抉择、收束/跃迁/欺骗时刻与伏笔回收）" },
        },
        required: ["tier", "title", "yearbook"],
      },
      run(args) {
        const deceived = gm.state.checkpoints.some((c) => c.status === "deceived");
        if (args.tier === "steins-gate" && !deceived) {
          throw new Error(
            "SG 线式结局要求至少一个检查点被标记为 deceived（已欺骗）。当前无欺骗记录，只能选择 convergence 或 branch。",
          );
        }
        gm.ending = {
          tier: str(args.tier, "tier"),
          title: str(args.title, "title"),
          yearbook: str(args.yearbook, "yearbook"),
        };
        return { ok: true };
      },
    },
    {
      name: "load_skill",
      description: "按需加载专题规则模块（对玩家不可见）。各模块的触发条件见系统提示词。",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            enum: Object.keys(GM_SKILLS),
            description: "要加载的专题模块 ID",
          },
        },
        required: ["id"],
      },
      run(args) {
        const id = str(args.id, "id") as GmSkillId;
        const skill = GM_SKILLS[id];
        if (!skill) {
          throw new Error(`未知模块 "${id}"，可选值：${Object.keys(GM_SKILLS).join(" / ")}`);
        }
        gm.loadedSkills.add(id);
        return skill.content;
      },
    },
  ];
  return tools.map(withNotify);
}
