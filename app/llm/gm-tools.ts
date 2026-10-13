import type { AgentTool } from "./agent";
import type { Checkpoint, Contradiction, ContradictionMagnitude, GmState } from "./types";

/** 矛盾量级档位 → 合法幅度区间（百分点，取绝对值）。restorative 为负方向。 */
const TIER_RANGES: Record<string, [number, number]> = {
  subtle: [0.001, 0.01], // 细微矛盾：善缘/伏笔/后手/细节错位（收束范围内分支移动）
  notable: [0.01, 0.05], // 显著矛盾：动摇检查点非承重环节
  fundamental: [0.1, 0.3], // 根本矛盾：斩断/替代承重条件——唯一参与跳线判定的量级
  restorative: [0.01, 0.1], // 修复性行动：消解已有矛盾（负）
  free: [0, 0.6], // 自由输入：可突破上限（奇思妙想值得奖励）
};

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

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
 * 核心节点（breach），或贴线脆弱状态（读数 ≥ 壁垒 80%）下仅需 1 个。
 * 细微/显著矛盾无论积累多少都永不触发跃迁。
 */
export function jumpReadiness(s: GmState): {
  ready: boolean;
  activeFundamental: number;
  fragile: boolean;
  breach: boolean;
} {
  const fund = s.contradictions.filter(
    (c) => c.status === "active" && c.magnitude === "fundamental",
  );
  const fragile = s.divergence >= round6(s.barrier * 0.8);
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
  /** 本幕是否已结算（settle 幂等约束；present_options/declare_ending 成功时复位） */
  settledThisAct: boolean;
  /** present_options 捕获的本幕选项 */
  options: string[] | null;
  /** declare_ending 捕获的结局 */
  ending: { tier: string; title: string; yearbook: string } | null;
}

export function freshInternals(barrier: number): GmInternals {
  return {
    state: {
      act: 0,
      worldline: "α",
      // 初始读数：0 或一个符合题材的随机值（0.337187% 式的质感），不超过壁垒的 60%
      divergence: Math.random() < 0.5 ? 0 : round6(Math.random() * barrier * 0.6),
      barrier,
      checkpoints: [],
      contradictions: [],
      history: [],
      ending: null,
    },
    settledThisAct: false,
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
  const jr = jumpReadiness(s);
  return (
    `[内部状态快照] 世界线=${s.worldline} 变动率=${s.divergence.toFixed(6)}% ` +
    `壁垒=${s.barrier.toFixed(6)}%${jr.fragile ? "（贴线脆弱）" : ""} 检查点=${cps} ` +
    `未消化矛盾=${cons}｜未消化根本矛盾×${jr.activeFundamental} ` +
    `跳线判定=${jr.ready ? "就绪（应跃迁）" : "不就绪"}`
  );
}

export function createGmTools(
  gm: GmInternals,
  /** present_options 调用后挂起等待的来源：玩家的行动文本（人或 agent 提供） */
  requestInput: (options: string[]) => Promise<string>,
): AgentTool[] {
  return [
    {
      name: "settle",
      description:
        "结算玩家行动制造的矛盾，记入矛盾清单（本游戏唯一的隐藏账本）。每幕必须且只能调用一次。tier 即矛盾量级（= 行动与既定因果链的冲突程度）：subtle 细微矛盾（世界消化得动的偏差：结善缘、埋伏笔、留后手、绕远路、细节错位——不改线，但铺设结局的因果链）/ notable 显著矛盾（动摇检查点的非承重环节）/ fundamental 根本矛盾（斩断或替代承重条件——唯一参与跳线判定的量级）/ restorative 修复性行动（主动消解已有矛盾、把剧情拉回主干，读数回落）/ free 自由输入（按分级表裁定，量级可突破上限）。delta 为幅度绝对值（百分点，六位小数，要有随机质感如 0.173294）。变动率是矛盾总量的读数，不是独立累加的数值：矛盾被消化，读数可以回落；细微与显著矛盾无论积累多少都永不触发跃迁，读数只能逼近壁垒而不越线。",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "玩家行动的一句话概括" },
          tier: { type: "string", enum: Object.keys(TIER_RANGES) },
          delta: { type: "number", description: "幅度绝对值，如 0.027436" },
          related: { type: "string", description: "关联的检查点 id（伏笔/后手/对抗的对象）" },
          breach: {
            type: "boolean",
            description: "本次行动直接击穿某个检查点的承重条件（仅 fundamental/free 可为 true，一次即可撕裂因果链）",
          },
          digests: {
            type: "array",
            items: { type: "string" },
            description: "restorative 专用：本行动消解的矛盾 id 列表",
          },
          note: { type: "string", description: "结算备注（收束手法、矛盾的性质等）" },
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
        gm.settledThisAct = true;
        s.history.push(
          `第${s.act}幕结算：${str(args.summary, "summary")}（${tier} ${signed >= 0 ? "+" : ""}${round6(signed)}% → ${next.toFixed(6)}%）${entry ? `｜记矛盾 ${entry.id}[${MAGNITUDE_LABEL[entry.magnitude]}]` : ""}${typeof args.note === "string" ? `｜${args.note}` : ""}`,
        );
        const jr = jumpReadiness(s);
        return {
          divergence: s.divergence,
          worldline: s.worldline,
          barrier: s.barrier,
          clamped,
          blockedAtBarrier,
          activeFundamental: jr.activeFundamental,
          fragile: jr.fragile,
          jumpReady: jr.ready,
          message: jr.ready
            ? "未消化的根本矛盾已撕裂因果链！必须调用 jump_worldline 完成跃迁（读数由你设定到新区间；旧检查点作废，新收束范围需要 define_checkpoints 重建）。"
            : blockedAtBarrier
              ? "读数已贴在壁垒内侧。读数本身不是跳线条件：细微/显著矛盾无论积累多少都永不跳线——跃迁只能靠未消化的根本矛盾撕裂因果链（贴线脆弱时仅需 1 个），或在含 cognition 承重条件的检查点上尝试欺骗世界。"
              : "结算完成。",
        };
      },
    },
    {
      name: "define_checkpoints",
      description:
        "定义当前收束范围的检查点（开局或跃迁后调用）。检查点不是一个'事件'，而是因果链上的结构节点：世界线需要的不是'某件事发生'，而是它撬动的下游因果（谁的命运因此转向、什么组织因此行动、什么真相因此浮出）。4~6 个节点连成一条因果链：每个节点写上游依赖（upstream，它承接哪些先前节点撬动的因果；首节点为空数组），并逐条写下承重条件（这条因果链断在哪一环就接不上），每条标注传导方式——cognition 经由某人认知（只有这类条件可以被伪造：收束锚定的是观测者的眼睛，不是事实本身），fact 经由事实本身（不可伪造，只可被玩家以真实手段促成——替代而非欺骗）。每收束范围至多 1 个'全部条件均为 cognition'的节点（宜放在链尾或弱下游，作为通往 SG 线式结局的窄门）；混合节点是更硬的窄门——认知环可以骗，事实环必须真。",
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
                content: { type: "string", description: "节点的显现事件及其因果功能，如「同伴死亡——其死迫使主角踏上复仇之路」" },
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
                      condition: { type: "string", description: "承重条件，如「冈部目击血泊中的助手并发出短信」" },
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
        const list = args.checkpoints;
        if (!Array.isArray(list) || list.length < 4 || list.length > 6) {
          throw new Error("检查点必须是 4~6 个，连成一条因果链。");
        }
        const seen = new Set<string>();
        for (const c of list as Checkpoint[]) {
          if (!Array.isArray(c.upstream)) {
            throw new Error(`检查点 ${c.id} 缺少 upstream：每个节点都要写上游依赖（首节点为空数组）——没有上游，这个节点就不会存在。`);
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
        const pureCognition = (list as Checkpoint[]).filter((c) =>
          c.conditions.every((x) => x.via === "cognition"),
        );
        if (pureCognition.length > 1) {
          throw new Error("每个收束范围至多 1 个'全部承重条件均为 cognition'的检查点（宜放在链尾或弱下游，作为通往 SG 线式结局的窄门），请重发。");
        }
        gm.state.checkpoints = (list as Omit<Checkpoint, "status">[]).map((c) => ({
          ...c,
          status: "pending" as const,
        }));
        return { ok: true, count: gm.state.checkpoints.length };
      },
    },
    {
      name: "update_checkpoint",
      description:
        "更新检查点状态：triggered 已触发（含收束重接线后变形接通、玩家以另一种方式主动满足节点的因果功能——世界线不问形式，只问因果）/ deceived 已被欺骗世界（因果需求被满足，同时事件本身被改写）/ void 作废（跃迁时引擎自动处理）。标 deceived 必须在 note 里逐条说明承重条件如何被保全（cognition 条件如何伪造、fact 条件如何被真实促成）。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["triggered", "deceived", "void"] },
          note: { type: "string", description: "触发/欺骗的方式" },
        },
        required: ["id", "status"],
      },
      run(args) {
        const cp = gm.state.checkpoints.find((c) => c.id === args.id);
        if (!cp) throw new Error(`找不到检查点 ${String(args.id)}`);
        if (args.status === "deceived") {
          if (!cp.conditions.some((x) => x.via === "cognition")) {
            throw new Error(
              "该检查点的承重条件全部经由事实传导，不经过任何人的认知——伪造只会被世界补完为真实（假死成真死、替身替死，参照：真由理之死）。纯事实节点不可欺骗：按欺骗失败处理（更狠的收束 + 代价代偿，暴露的矛盾用 digest_contradiction 作废），或等玩家以真实手段促成因果功能后标 triggered。",
            );
          }
          if (typeof args.note !== "string" || !args.note.trim()) {
            throw new Error("标记 deceived 必须在 note 里逐条说明承重条件如何被保全：cognition 条件如何伪造、fact 条件如何被真实促成。");
          }
        }
        cp.status = args.status as Checkpoint["status"];
        if (typeof args.note === "string") cp.note = args.note;
        return { ok: true, checkpoint: cp };
      },
    },
    {
      name: "digest_contradiction",
      description:
        "消化或作废一条矛盾（settle 之外的销账）：矛盾被消化（收束、修复性行动），读数可以回落；欺骗失败暴露的伏笔作废（从矛盾清单中划去）。未消化根本矛盾减少时，跳线判定随之回落。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "矛盾 id（快照里的 C1/C2/…）" },
          void: { type: "boolean", description: "true = 作废（欺骗失败暴露），缺省 = 消化" },
          note: { type: "string", description: "消化/作废的方式" },
        },
        required: ["id"],
      },
      run(args) {
        const c = gm.state.contradictions.find((x) => x.id === args.id);
        if (!c) throw new Error(`找不到矛盾 ${String(args.id)}`);
        if (c.status !== "active") throw new Error(`矛盾 ${c.id} 已是 ${c.status} 状态。`);
        c.status = args.void === true ? "void" : "digested";
        if (typeof args.note === "string") c.note = args.note;
        const jr = jumpReadiness(gm.state);
        return { ok: true, contradiction: c, activeFundamental: jr.activeFundamental, jumpReady: jr.ready };
      },
    },
    {
      name: "jump_worldline",
      description:
        "世界线跃迁。跳线的唯一条件是矛盾，不是读数：仅当未消化的根本矛盾撕裂因果链（settle/digest_contradiction 返回 jumpReady=true）时可调用。旧收束范围的所有既定检查点作废；读数设定到新区间（≥ 区间下界），具体值反映累计矛盾的程度。跃迁对玩家和角色完全隐形：叙事自然延续，只是世界的状态已经不同。",
      parameters: {
        type: "object",
        properties: {
          worldline: { type: "string", description: "新收束范围名称（β/γ/δ…依次命名）" },
          divergence: { type: "number", description: "跃迁后的读数，必须落在新区间内（六位小数）" },
          note: { type: "string" },
        },
        required: ["worldline", "divergence"],
      },
      run(args) {
        const s = gm.state;
        const jr = jumpReadiness(s);
        if (!jr.ready) {
          throw new Error(
            `因果链尚可自洽，不许跃迁（未消化根本矛盾×${jr.activeFundamental}${jr.fragile ? "，贴线脆弱" : ""}）。跳线的唯一条件是矛盾：根本矛盾通常需积累 2 个以上，贴线脆弱（读数≥壁垒80%）时 1 个即可，或直接击穿核心节点。细微/显著矛盾无论积累多少都永不跳线。`,
          );
        }
        // 区间宽度恒 1%、整数边界即壁垒：新区间 = [ceil(旧壁垒), ceil(旧壁垒)+1]
        const lower = Math.ceil(s.barrier);
        const newBarrier = lower + 1;
        const d = typeof args.divergence === "number" ? args.divergence : NaN;
        if (Number.isNaN(d) || d < lower || d >= newBarrier) {
          throw new Error(`跃迁后的读数必须落在新区间 [${lower.toFixed(6)}%, ${newBarrier.toFixed(6)}%) 内，收到 ${String(args.divergence)}。`);
        }
        s.worldline = str(args.worldline, "worldline");
        s.barrier = newBarrier;
        s.divergence = round6(d);
        for (const cp of s.checkpoints) if (cp.status === "pending") cp.status = "void";
        s.history.push(
          `⚡ 跃迁至 ${s.worldline} 线（读数 ${s.divergence.toFixed(6)}%），旧检查点作废，新壁垒 ${s.barrier.toFixed(6)}%${typeof args.note === "string" ? `｜${args.note}` : ""}`,
        );
        return {
          ok: true,
          worldline: s.worldline,
          divergence: s.divergence,
          barrier: s.barrier,
          message: "跃迁完成。请调用 define_checkpoints 为新收束范围重建 4~6 个检查点（基调呼应玩家打破旧命运的方式）。",
        };
      },
    },
    {
      name: "present_options",
      description:
        "递交本幕选项并等待玩家行动：调用后游戏暂停，本工具的结果就是玩家的行动文本 + 最新内部状态快照。这是你和玩家之间唯一的桥梁。选项 2~4 个，要真正有区分度（不是同一行动的三种说法）；选项池里至少一个'顺从惯性'、至少一个'有点越界'，但顺序每幕随机，绝不按'顺从→激进'或任何性质梯度排序——固定排序等于开辅助。玩家可以随时不理会选项、自填自由行动——这就是自由输入通道。终幕不给分支选项：所有检查点尘埃落定后可递交空选项列表，只等玩家对整条世界线的最后回答。",
      parameters: {
        type: "object",
        properties: {
          options: { type: "array", items: { type: "string" }, maxItems: 4 },
        },
        required: ["options"],
      },
      async run(args) {
        if (gm.state.act >= 1 && !gm.settledThisAct) {
          throw new Error("本幕尚未结算：先调用 settle 结算玩家行动，再递交选项。");
        }
        const opts = args.options;
        // 终幕（当前收束范围没有 pending 检查点）不给分支选项：允许空选项列表
        const finale =
          gm.state.checkpoints.length > 0 &&
          gm.state.checkpoints.every((c) => c.status !== "pending");
        const min = finale ? 0 : 2;
        if (!Array.isArray(opts) || opts.length < min || opts.length > 4) {
          throw new Error(
            finale
              ? "终幕可以不给选项（空数组），或最多 4 个"
              : "选项必须是 2~4 个字符串",
          );
        }
        // 全部校验通过、且玩家已行动之后，才允许改状态——
        // requestInput 抛错（如本幕无正文、玩家中止）时不能留下半变更的死锁状态
        const action = await requestInput(opts.map(String));
        gm.options = opts.map(String);
        gm.settledThisAct = false;
        return `${snapshot(gm)}\n[玩家行动] ${action}`;
      },
    },
    {
      name: "declare_ending",
      description:
        "宣告结局（当前收束范围的最后一个检查点被触发后）。tier：convergence 收束结局 / branch 分支结局 / steins-gate SG 线式结局（要求至少一个检查点 deceived）。结局以世界线命名，并附世界线年鉴——此时一次性揭晓全部账本与判定：回顾每一幕的关键选择、每次收束/跃迁/欺骗时刻、玩家曾试图改变却失败的事、结算矛盾清单（揭晓哪些看似无用的细微矛盾原来是伏笔）。",
      parameters: {
        type: "object",
        properties: {
          tier: { type: "string", enum: ["convergence", "branch", "steins-gate"] },
          title: { type: "string", description: "如「α 世界线 · 0.910312% 子夜波段，收束完毕」" },
          yearbook: { type: "string", description: "世界线年鉴全文" },
        },
        required: ["tier", "title", "yearbook"],
      },
      run(args) {
        const deceived = gm.state.checkpoints.some((c) => c.status === "deceived");
        if (args.tier === "steins-gate" && !deceived) {
          throw new Error("SG 线式结局要求至少一个检查点被【已欺骗】。没有欺骗记录只能给 convergence/branch。");
        }
        gm.ending = {
          tier: str(args.tier, "tier"),
          title: str(args.title, "title"),
          yearbook: str(args.yearbook, "yearbook"),
        };
        return { ok: true };
      },
    },
  ];
}
