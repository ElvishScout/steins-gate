"use client";

import { useEffect, useRef, useState } from "react";
import { Agent } from "./llm/agent";
import { GameEngine, type EngineHooks } from "./llm/engine";
import { chat } from "./llm/llm";
import { buildPlayerPrompt, type PlayerStyleId } from "./llm/prompts/player";
import type { Ending, GameSetup, GmDebugEvent, LLMConfig, Scene } from "./llm/types";
import {
  createDefaultSettingsState,
  loadModelSettings,
  resolveRoleConfig,
  saveModelSettings,
  type ModelSettingsState,
} from "./components/ConfigForm";
import { TopBar } from "./components/TopBar";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { SetupPanel } from "./components/SetupPanel";
import { BottomDock } from "./components/BottomDock";
import { StoryLog, type LiveGM, type LivePlayer } from "./components/StoryLog";
import { copyHistoryMarkdown, downloadHistoryMarkdown } from "./components/exportHistory";
import type { Entry, Mode } from "./components/entries";

/** 观战模式：把场景格式化成发给玩家 agent 的纯文本（不含任何状态；选项不带编号——玩家只输出行动文本）。 */
function formatScene(s: Scene): string {
  const opts = s.options.map((o) => `· ${o}`).join("\n");
  return `${s.narration}\n\n${opts}\n\n（或者自由输入任何行动。）`;
}

export default function Home() {
  const [settings, setSettings] = useState<ModelSettingsState>(createDefaultSettingsState);
  const gmConfig = resolveRoleConfig(settings, "gm");
  const playerConfig = resolveRoleConfig(settings, "player");
  const [mode, setMode] = useState<Mode>("play");
  const [genre, setGenre] = useState("");
  const [protagonist, setProtagonist] = useState("");
  const [playerStyle, setPlayerStyle] = useState<PlayerStyleId>("curious");
  const [difficulty, setDifficulty] = useState<GameSetup["difficulty"]>("standard");
  const [showHidden, setShowHidden] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [live, setLive] = useState<LiveGM | null>(null);
  const [playerLive, setPlayerLive] = useState<LivePlayer | null>(null);
  const [busy, setBusy] = useState(false);
  const [waitingInput, setWaitingInput] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  /** 被主动停止（区别于自然终局）：顶栏显示「重新开始」，点了才回初始面板 */
  const [stopped, setStopped] = useState(false);
  /** 当前是否存在因请求失败或手动中断而可重试的回合 */
  const [canRetry, setCanRetry] = useState(false);
  const [testingGm, setTestingGm] = useState(false);
  const [testingPlayer, setTestingPlayer] = useState(false);

  const engineRef = useRef<GameEngine | null>(null);
  const playerRef = useRef<Agent | null>(null);
  /** 观战模式下玩家 agent 待重试的场景（为 null 表示重试目标是 GM 回合） */
  const pendingPlayerSceneRef = useRef<Scene | null>(null);
  const inputResolverRef = useRef<((action: string) => void) | null>(null);
  /** 流式累加的真源（setLive 只是它的快照）：归档进条目时从这里取 */
  const liveRef = useRef<{ narration: string; events: GmDebugEvent[] }>({
    narration: "",
    events: [],
  });
  const endingRef = useRef<Ending | null>(null);

  useEffect(() => {
    // localStorage 只在客户端可用，必须在挂载后读取（SSR 时没有 window）
    const loaded = loadModelSettings();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSettings(loaded);
    const gm = resolveRoleConfig(loaded, "gm");
    // 「展示隐藏状态」不持久化：每次进页面默认关闭，防止意外剧透
    if (!gm?.baseURL) setDrawerOpen(true);
  }, []);

  const test = async (c: LLMConfig, setTesting: (b: boolean) => void) => {
    setTesting(true);
    try {
      const r = await chat(c, [{ role: "user", content: "回复 pong 两个字即可。" }]);
      alert(r.content ? `连接成功：${r.content.slice(0, 50)}` : "连接成功（空回复）");
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const pushEntry = (e: Entry) => setEntries((prev) => [...prev, e]);

  /** 把流式真源同步到 React state（每次增量一个新快照） */
  const syncLive = () => setLive({ ...liveRef.current, events: [...liveRef.current.events] });

  /** 归档当前流式缓冲区，返回其中的调试事件（附注：产出侧归属） */
  const drainLive = (): GmDebugEvent[] => {
    const events = liveRef.current.events;
    liveRef.current = { narration: "", events: [] };
    setLive(null);
    return events;
  };

  /** 观战模式：玩家 agent 行动（正文与思维链双流式），回复入流并附上思维链 */
  const runPlayer = async (player: Agent, input: string | null): Promise<string> => {
    const histLen = player.history.length;
    setPlayerLive({ text: "", reasoning: "" });
    let text = "";
    let reasoning = "";
    try {
      const action = await player.step(input, {
        signal: engineRef.current?.signal,
        onText: (d) => {
          text += d;
          setPlayerLive((prev) => (prev ? { ...prev, text: prev.text + d } : prev));
        },
        onReasoning: (d) => {
          reasoning += d;
          setPlayerLive((prev) => (prev ? { ...prev, reasoning: prev.reasoning + d } : prev));
        },
      });
      setPlayerLive(null);
      pendingPlayerSceneRef.current = null;
      pushEntry({
        kind: "action",
        text: action,
        by: "player-agent",
        // 无思维链则不展示附注（直接没有，不留占位）
        ...(reasoning ? { debug: { events: [{ type: "reasoning" as const, text: reasoning }], state: null } } : {}),
      });
      return action;
    } catch (e) {
      // 玩家请求失败或中断：回滚刚刚压入的 user 消息，保留已流出的半截内容供查看（若均为空则清掉占位）
      player.history.length = histLen;
      if (!text && !reasoning) setPlayerLive(null);
      throw e;
    }
  };

  /** Sync current model settings into existing agents so retry uses updated config */
  const syncAgentConfigs = () => {
    if (engineRef.current && gmConfig) engineRef.current.updateConfig(gmConfig);
    if (playerRef.current && playerConfig) playerRef.current.config = playerConfig;
  };

  const canStart =
    !!gmConfig?.baseURL &&
    !!gmConfig?.apiKey &&
    !!gmConfig?.model &&
    (mode === "play" ||
      (!!playerConfig?.baseURL && !!playerConfig?.apiKey && !!playerConfig?.model));

  const makeHooks = (player: Agent | null): EngineHooks => ({
    onChunk: (d) => {
      liveRef.current.narration += d;
      syncLive();
    },
    onDebug: (ev) => {
      const evs = liveRef.current.events;
      const last = evs[evs.length - 1];
      // 连续的思维链增量合并成一段（否则每个 token 渲染成一行）；工具事件天然分段
      if (ev.type === "reasoning" && last?.type === "reasoning") last.text += ev.text;
      else evs.push(ev);
      syncLive();
    },
    onScene: async (scene) => {
      pushEntry({
        kind: "scene",
        act: scene.act,
        narration: scene.narration,
        options: scene.options,
        debug: { events: drainLive(), state: scene.state },
      });
      if (player) {
        pendingPlayerSceneRef.current = scene;
        return runPlayer(player, formatScene(scene));
      }
      // 人类玩家：挂起直到 act() 投递输入
      setWaitingInput(true);
      return new Promise<string>((resolve) => {
        inputResolverRef.current = resolve;
      });
    },
    onEnding: (e, state) => {
      setGameOver(true);
      setCanRetry(false);
      endingRef.current = e;
      pushEntry({
        kind: "ending",
        title: e.title,
        yearbook: e.yearbook,
        debug: { events: drainLive(), state },
      });
    },
  });

  /** 执行或恢复 GM 循环，统一处理主动中断与请求异常的收尾 */
  const runEngineTask = async (task: () => Promise<void>) => {
    try {
      await task();
      // play()/retry() 静默返回 = 被主动停止（自然终局走 onEnding，异常走 catch）
      const ended = endingRef.current as Ending | null;
      if (!ended) {
        if (!liveRef.current.narration && liveRef.current.events.length === 0) {
          setLive(null);
        }
        setStopped(true);
        setCanRetry(Boolean(engineRef.current?.canRetry || pendingPlayerSceneRef.current));
      }
    } catch (e) {
      if (!liveRef.current.narration && liveRef.current.events.length === 0) {
        setLive(null);
      }
      pushEntry({ kind: "error", text: e instanceof Error ? e.message : String(e) });
      setStopped(true);
      setCanRetry(Boolean(engineRef.current?.canRetry || pendingPlayerSceneRef.current));
    } finally {
      setBusy(false);
      setWaitingInput(false);
      inputResolverRef.current = null;
    }
  };

  const startGame = async () => {
    if (!gmConfig) return;
    setBusy(true);
    setEntries([]);
    setGameOver(false);
    setStopped(false);
    setCanRetry(false);
    setDrawerOpen(false); // 开局即收起抽屉，屏幕让给故事
    endingRef.current = null;
    pendingPlayerSceneRef.current = null;
    liveRef.current = { narration: "", events: [] };
    setLive(null);
    setPlayerLive(null);
    const engine = new GameEngine(gmConfig);
    engineRef.current = engine;
    // 观战模式：玩家侧也是一个 agent，由页面持有，作为 onScene 的输入来源
    const player =
      mode === "spectate" && playerConfig
        ? new Agent(playerConfig, buildPlayerPrompt(playerStyle), "player")
        : null;
    playerRef.current = player;
    const setup: GameSetup = { genre, protagonist, difficulty };
    await runEngineTask(() => engine.play(setup, makeHooks(player)));
  };

  /** 失败或手动中断后重试当前未完成的 LLM 请求 */
  const retry = async () => {
    const engine = engineRef.current;
    if (!engine || busy || gameOver) return;
    syncAgentConfigs();
    // 移除末尾的报错框，清理上一次半截流式残片
    setEntries((prev) => {
      const next = [...prev];
      while (next.length > 0 && next[next.length - 1].kind === "error") {
        next.pop();
      }
      return next;
    });
    setStopped(false);
    setCanRetry(false);
    setBusy(true);
    engine.resetAbortController();

    const player = playerRef.current;
    const pendingScene = pendingPlayerSceneRef.current;
    // 若中断或失败发生在观战模式的玩家 agent 回合，先重跑玩家回合拿到行动，再写入引擎检查点继续 GM
    if (player && pendingScene) {
      let action: string;
      try {
        action = await runPlayer(player, formatScene(pendingScene));
      } catch (e) {
        if (!engine.signal?.aborted) {
          pushEntry({ kind: "error", text: e instanceof Error ? e.message : String(e) });
        }
        setStopped(true);
        setCanRetry(true);
        setBusy(false);
        return;
      }
      engine.completePendingAction(action);
    }

    // 若人类玩家在等待输入期间点击了停止，重试即恢复等待输入并可继续行动
    if (!player && engine.hasPendingInput) {
      setWaitingInput(true);
      try {
        const action = await new Promise<string>((resolve, reject) => {
          inputResolverRef.current = resolve;
          engine.onStopInputWait(() => reject(new Error("已停止")));
        });
        engine.onStopInputWait(null);
        engine.completePendingAction(action);
      } catch {
        engine.onStopInputWait(null);
        inputResolverRef.current = null;
        setStopped(true);
        setCanRetry(true);
        setBusy(false);
        setWaitingInput(false);
        return;
      }
    }

    liveRef.current = { narration: "", events: [] };
    setLive({ narration: "", events: [] });
    setPlayerLive(null);
    await runEngineTask(() => engine.retry(makeHooks(player)));
  };

  /** 人类玩家递交行动：解开引擎里挂起的 present_options */
  const act = (action: string) => {
    const resolve = inputResolverRef.current;
    if (!resolve) return;
    inputResolverRef.current = null;
    setWaitingInput(false);
    pushEntry({ kind: "action", text: action, by: "human" });
    liveRef.current = { narration: "", events: [] };
    setLive({ narration: "", events: [] }); // GM 即将开始输出下一幕
    resolve(action);
  };

  /** 重新开始：清空对局回到初始面板（题材/主角/模式等设置保留，默认填入上一局的） */
  const restart = () => {
    engineRef.current?.stop();
    setEntries([]);
    setLive(null);
    setPlayerLive(null);
    liveRef.current = { narration: "", events: [] };
    pendingPlayerSceneRef.current = null;
    setGameOver(false);
    setStopped(false);
    setCanRetry(false);
    setWaitingInput(false);
  };

  const lastScene = [...entries].reverse().find((e) => e.kind === "scene");
  const showCover = entries.length === 0 && !live && !busy && !stopped && !gameOver;

  return (
    <div className="flex min-h-screen flex-col">
      <TopBar
        difficulty={difficulty}
        onDifficulty={setDifficulty}
        busy={busy}
        onStop={() => engineRef.current?.stop()}
        hasEntries={entries.length > 0 || stopped || gameOver}
        onRestart={restart}
        canSave={entries.length > 0}
        onSave={({ includeReasoning, includeTools }) =>
          downloadHistoryMarkdown({
            entries,
            includeReasoning,
            includeTools,
            mode,
            difficulty,
            genre,
            protagonist,
            playerStyle,
            gmModel: gmConfig?.model,
            playerModel: playerConfig?.model,
          })
        }
        onCopy={({ includeReasoning, includeTools }) =>
          copyHistoryMarkdown({
            entries,
            includeReasoning,
            includeTools,
            mode,
            difficulty,
            genre,
            protagonist,
            playerStyle,
            gmModel: gmConfig?.model,
            playerModel: playerConfig?.model,
          })
        }
        showHidden={showHidden}
        onShowHidden={setShowHidden}
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((v) => !v)}
      />

      {drawerOpen && (
        <SettingsDrawer
          settings={settings}
          onChange={(next) => {
            setSettings(next);
            saveModelSettings(next);
          }}
          onClose={() => setDrawerOpen(false)}
          onTest={(c, which) => test(c, which === "gm" ? setTestingGm : setTestingPlayer)}
          testingGm={testingGm}
          testingPlayer={testingPlayer}
        />
      )}

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-2.5 px-3 py-2.5 sm:px-4">
        <div className="flex-1">
          {showCover ? (
            <SetupPanel
              mode={mode}
              onMode={setMode}
              genre={genre}
              onGenre={setGenre}
              protagonist={protagonist}
              onProtagonist={setProtagonist}
              playerStyle={playerStyle}
              onPlayerStyle={setPlayerStyle}
              canStart={canStart}
              onStart={startGame}
              onOpenSettings={() => setDrawerOpen(true)}
            />
          ) : (
            <StoryLog
              entries={entries}
              live={live}
              playerLive={playerLive}
              busy={busy}
              showHidden={showHidden}
              onRetry={canRetry && !gameOver ? retry : undefined}
            />
          )}
        </div>

        <BottomDock
          mode={mode}
          busy={busy}
          gameOver={gameOver}
          waitingInput={waitingInput}
          playerThinking={playerLive !== null}
          options={lastScene?.options ?? []}
          onSubmit={act}
          onRestart={startGame}
        />
      </main>
    </div>
  );
}
