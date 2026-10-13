import type { LLMConfig } from "../llm/types";
import { ConfigForm } from "./ConfigForm";

/** ⚙ 抽屉：只装配好一次就基本不动的双模型配置 */
export function SettingsDrawer(props: {
  gmConfig: LLMConfig;
  onGmConfig: (c: LLMConfig) => void;
  playerConfig: LLMConfig;
  onPlayerConfig: (c: LLMConfig) => void;
  onTest: (c: LLMConfig, which: "gm" | "player") => void;
  testingGm: boolean;
  testingPlayer: boolean;
}) {
  return (
    <div className="grid gap-3 rounded border border-line bg-paper-dim p-3 sm:grid-cols-2">
      <ConfigForm
        label="GM 模型"
        value={props.gmConfig}
        onChange={props.onGmConfig}
        onTest={() => props.onTest(props.gmConfig, "gm")}
        testing={props.testingGm}
      />
      <ConfigForm
        label="玩家模型（观战模式用）"
        value={props.playerConfig}
        onChange={props.onPlayerConfig}
        onTest={() => props.onTest(props.playerConfig, "player")}
        testing={props.testingPlayer}
      />
    </div>
  );
}
