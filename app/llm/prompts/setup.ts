import type { AgentTool } from "../agent";
import type { GameSetup, GmDebugEvent, GmState } from "../types";

/** 题材词库：宽泛、开放的故事类型与领域，留出充分的创作空间 */
const GENRE_KEYWORDS: readonly string[] = [
  "都市日常", "职场博弈", "校园青春", "市井烟火", "家族往事",
  "悬疑推理", "历史风云", "江湖武侠", "边塞奇谭", "古典志怪",
  "年代记忆", "小镇轶事", "公路旅途", "孤岛群像", "远洋航海",
  "极地科考", "近未来科幻", "赛博朋克", "太空探索", "末日废土",
  "蒸汽朋克", "奇幻冒险", "医疗现场", "律政风云", "商界浮沉",
  "谍战暗流", "民俗传说", "考古探秘", "艺术台前幕后", "竞技赛场",
  "纪实调查", "乡野田园", "丝路商旅", "深海潜航", "架空历史",
  "心理博弈", "金融暗战", "旧城变迁", "学术江湖", "剧团人生",
];

/** 意象词库：凝练、多义的文学意象，可具象可隐喻，不限制具体情节 */
const IMAGERY_KEYWORDS: readonly string[] = [
  "晨雾", "烈日", "初雪", "梅雨", "晚风", "潮汐", "余烬", "星轨",
  "钟摆", "倒影", "钥匙", "信笺", "渡口", "回声", "迷宫", "棋局",
  "候鸟", "篝火", "灯塔", "暗流", "荒原", "蝉鸣", "落叶", "微光",
  "裂痕", "天平", "面具", "车辙", "风铃", "沙漏", "苔藓", "孤岛",
  "花火", "归途", "晴空", "浮冰", "残局", "弦音", "门槛", "远山",
  "霓虹", "尘埃", "暖茶", "旧票根", "长阶", "风向标", "白昼焰火", "十字路口",
];

/** 跨语言通用字母/音节开头种子（含元音与辅音）：用于打散模型默认的姓名采样偏好 */
const PHONETIC_SEEDS: readonly string[] = [
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
  "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
  "Ch", "Sh", "Zh",
];

/** 从词库中无放回随机抽取 n 个元素 */
function pickRandom<T>(pool: readonly T[], count: number): T[] {
  const copy = [...pool];
  const n = Math.min(count, copy.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/** 随机抽取一批题材词、意象词与跨语言语音种子 */
export function rollInspiration() {
  return {
    genres: pickRandom(GENRE_KEYWORDS, 6),
    imagery: pickRandom(IMAGERY_KEYWORDS, 8),
    nameInitials: pickRandom(PHONETIC_SEEDS, 4),
    note: "若玩家已指定题材方向则忽略 genres；可从 imagery 中挑 1～3 个契合基调的意象融入背景；代拟人物姓名时请结合故事所属语言文化，参考 nameInitials 的字母/音节开头自由命名。",
  };
}

/** 构造开局设定子代理的工具集：roll_inspiration + submit_setup */
export function createSetupTools(
  setup: GameSetup,
  state: GmState,
  notify?: (ev: GmDebugEvent) => void,
): AgentTool[] {
  const withNotify = (tool: AgentTool): AgentTool => {
    if (!notify) return tool;
    return {
      ...tool,
      async run(args) {
        try {
          const result = await tool.run(args);
          notify({
            type: "tool",
            name: tool.name,
            args: tool.name === "roll_inspiration" && result && typeof result === "object"
              ? (result as Record<string, unknown>)
              : args,
            state: structuredClone(state),
          });
          return result;
        } catch (e) {
          notify({
            type: "tool",
            name: tool.name,
            args,
            state: structuredClone(state),
            error: e instanceof Error ? e.message : String(e),
          });
          throw e;
        }
      },
    };
  };

  const tools: AgentTool[] = [
    {
      name: "roll_inspiration",
      description:
        "随机抽取题材词、文学意象词与跨语言起名语音种子。当题材未指定、仍属开放性方向，或主角姓名尚未锁定时调用。",
      parameters: {
        type: "object",
        properties: {},
      },
      run() {
        return rollInspiration();
      },
    },
    {
      name: "submit_setup",
      description: "提交整理或扩充后的本局题材世界观与主角设定，完成开局设定准备。",
      parameters: {
        type: "object",
        properties: {
          genre: {
            type: "string",
            description: "确定的题材、世界观背景与第 1 幕开场切入情境",
          },
          protagonist: {
            type: "string",
            description: "确定的主角姓名、身份处境与性格特点",
          },
        },
        required: ["genre", "protagonist"],
      },
      run(args) {
        const genre = typeof args.genre === "string" ? args.genre.trim() : "";
        const protagonist = typeof args.protagonist === "string" ? args.protagonist.trim() : "";
        if (!genre || !protagonist) {
          throw new Error("genre 与 protagonist 均不能为空");
        }
        setup.genre = genre;
        setup.protagonist = protagonist;
        return { ok: true };
      },
    },
  ];

  return tools.map(withNotify);
}

export function buildSetupPrompt(): string {
  return `你是互动小说「收束」的开局设定子代理。你的任务是根据玩家的初始输入，整理或补全出一份具体的「题材与世界观」与「主角设定」，通过 \`submit_setup\` 工具移交给主主持人（GM）。

工作规则：
1. **按确定性决定是否调用 \`roll_inspiration\`**：
   - 若「题材与世界观」未指定、或仅给出宽泛的开放性方向（具体背景脉络与开场情境尚未锁定），或「主角设定」尚未确定具体姓名与身份，先调用 \`roll_inspiration\` 获取随机灵感与语音种子；
   - 若设定已具有高确定性（如明确要求还原某部已知作品、特定历史事件，且主角与开场情境均已确定），则无需调用 \`roll_inspiration\`。
2. **补全与命名规范**：
   - 玩家已指定明确作品或具体设定时，忠实保留其核心设定、原作人物姓名与开场背景，仅做条理化整理。
   - 题材或主角留白时，结合随机灵感构建具体、有生活实感的故事背景与开场切入点（80～180 字），并拟定主角的姓名、身份处境与性格底色（40～100 字）。
   - 人物姓名须契合故事所属的地域、年代与语言文化（中、日、西文、奇幻等皆从其背景）。构拟姓名时参考 \`nameInitials\` 的字母/音节开头自由组合，避开单一高频字（如单字"砚""澈""烬"等）的重复套用。
3. **提交结果**：完成构思后，调用 \`submit_setup\` 提交最终的 \`genre\` 与 \`protagonist\`，不输出额外正文。`;
}

export function buildSetupUserMessage(setup: GameSetup): string {
  return `[玩家初始输入]
- 主角设定：${setup.protagonist?.trim() || "未指定"}
- 题材与世界观：${setup.genre?.trim() || "未指定"}`;
}
