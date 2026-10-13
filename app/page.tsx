"use client";

import { useEffect, useRef, useState } from "react";
import { Agent } from "./llm/agent";
import { GameEngine } from "./llm/engine";
import { chat } from "./llm/llm";
import { PLAYER_PROMPT } from "./llm/prompts/gm";
import type { GameSetup, GmState, LLMConfig, Scene } from "./llm/types";

type Entry =
  | { kind: "scene"; act: number; narration: string; options: string[] }
  | { kind: "action"; text: string; by: "human" | "player-agent" }
  | { kind: "ending"; title: string; yearbook: string }
  | { kind: "error"; text: string };

type Mode = "play" | "spectate";

const EMPTY_CONFIG: LLMConfig = { baseURL: "", apiKey: "", model: "" };
const LETTERS = ["A", "B", "C", "D"] as const;

/** 观战模式：把场景格式化成发给玩家 agent 的纯文本（不含任何状态）。 */
function formatScene(s: Scene): string {
  const opts = s.options.map((o, i) => `${LETTERS[i]}. ${o}`).join("\n");
  return `${s.narration}\n\n${opts}\n\n（或者自由输入任何行动。）`;
}

function loadConfig(key: string): LLMConfig {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...EMPTY_CONFIG, ...JSON.parse(raw) };
  } catch {
    /* localStorage 不可用时用空配置 */
  }
  return EMPTY_CONFIG;
}

function ConfigForm(props: {
  label: string;
  value: LLMConfig;
  onChange: (c: LLMConfig) => void;
  onTest: () => void;
  testing: boolean;
}) {
  const { label, value, onChange } = props;
  const field = (
    name: keyof LLMConfig,
    placeholder: string,
    type = "text",
  ) => (
    <input
      className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100 placeholder:text-zinc-600"
      placeholder={placeholder}
      type={type}
      value={(value[name] as string) ?? ""}
      onChange={(e) => onChange({ ...value, [name]: e.target.value })}
    />
  );
  return (
    <fieldset className="flex flex-col gap-2 rounded border border-zinc-800 p-3">
      <legend className="px-1 text-xs text-zinc-400">{label}</legend>
      {field("baseURL", "baseURL，如 https://你的中转/v1")}
      {field("apiKey", "apiKey", "password")}
      {field("model", "model，如 deepseek-chat")}
      <select
        className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100"
        value={value.reasoningEffort ?? ""}
        onChange={(e) =>
          onChange({
            ...value,
            reasoningEffort: (e.target.value || undefined) as LLMConfig["reasoningEffort"],
          })
        }
      >
        <option value="">reasoning effort：默认（不传）</option>
        <option value="none">reasoning effort: none</option>
        <option value="low">reasoning effort: low</option>
        <option value="medium">reasoning effort: medium</option>
        <option value="high">reasoning effort: high</option>
      </select>
      <button
        className="self-start rounded bg-zinc-700 px-2 py-1 text-xs hover:bg-zinc-600 disabled:opacity-40"
        onClick={props.onTest}
        disabled={props.testing || !value.baseURL || !value.apiKey || !value.model}
      >
        {props.testing ? "测试中…" : "测试连接"}
      </button>
    </fieldset>
  );
}

export default function Home() {
  const [gmConfig, setGmConfig] = useState<LLMConfig>(EMPTY_CONFIG);
  const [playerConfig, setPlayerConfig] = useState<LLMConfig>(EMPTY_CONFIG);
  const [mode, setMode] = useState<Mode>("play");
  const [genre, setGenre] = useState("");
  const [protagonist, setProtagonist] = useState("");
  const [difficulty, setDifficulty] = useState<GameSetup["difficulty"]>("standard");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waitingInput, setWaitingInput] = useState(false);
  const [freeInput, setFreeInput] = useState("");
  const [testingGm, setTestingGm] = useState(false);
  const [testingPlayer, setTestingPlayer] = useState(false);
  const [gmState, setGmState] = useState<GmState | null>(null);
  const [gameOver, setGameOver] = useState(false);

  const engineRef = useRef<GameEngine | null>(null);
  const inputResolverRef = useRef<((action: string) => void) | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // localStorage 只在客户端可用，必须在挂载后读取（SSR 时没有 window）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGmConfig(loadConfig("sg:gm"));
    setPlayerConfig(loadConfig("sg:player"));
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [entries, streaming]);

  const saveConfig = (key: string, c: LLMConfig) => {
    try {
      localStorage.setItem(key, JSON.stringify(c));
    } catch {
      /* ignore */
    }
  };

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

  const startGame = async () => {
    setBusy(true);
    setEntries([]);
    setGameOver(false);
    setGmState(null);
    const engine = new GameEngine(gmConfig);
    engineRef.current = engine;
    // 观战模式：玩家侧也是一个 agent，由页面持有，作为 onScene 的输入来源
    const player = mode === "spectate" ? new Agent(playerConfig, PLAYER_PROMPT, "player") : null;
    const setup: GameSetup = { genre, protagonist, difficulty };
    try {
      await engine.play(setup, {
        onChunk: (t) => setStreaming((prev) => (prev ?? "") + t),
        onScene: async (scene) => {
          setStreaming(null);
          setGmState(scene.state);
          pushEntry({ kind: "scene", act: scene.act, narration: scene.narration, options: scene.options });
          if (player) {
            const action = await player.step(formatScene(scene));
            pushEntry({ kind: "action", text: action, by: "player-agent" });
            return action;
          }
          // 人类玩家：挂起直到 act() 投递输入
          setWaitingInput(true);
          return new Promise<string>((resolve) => {
            inputResolverRef.current = resolve;
          });
        },
        onEnding: (ending, state) => {
          setStreaming(null);
          setGmState(state);
          setGameOver(true);
          pushEntry({ kind: "ending", title: ending.title, yearbook: ending.yearbook });
        },
      });
    } catch (e) {
      setStreaming(null);
      pushEntry({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      setWaitingInput(false);
      inputResolverRef.current = null;
    }
  };

  /** 人类玩家递交行动：解开引擎里挂起的 present_options */
  const act = (action: string) => {
    const resolve = inputResolverRef.current;
    if (!resolve) return;
    inputResolverRef.current = null;
    setWaitingInput(false);
    pushEntry({ kind: "action", text: action, by: "human" });
    setStreaming(""); // GM 即将开始输出下一幕
    resolve(action);
  };

  const lastScene = [...entries].reverse().find((e) => e.kind === "scene");

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-6 text-zinc-100">
      <h1 className="text-xl font-bold">世界线收束物语</h1>

      <div className="grid gap-3 sm:grid-cols-2">
        <ConfigForm
          label="GM 模型"
          value={gmConfig}
          onChange={(c) => { setGmConfig(c); saveConfig("sg:gm", c); }}
          onTest={() => test(gmConfig, setTestingGm)}
          testing={testingGm}
        />
        <ConfigForm
          label="玩家模型（观战模式用）"
          value={playerConfig}
          onChange={(c) => { setPlayerConfig(c); saveConfig("sg:player", c); }}
          onTest={() => test(playerConfig, setTestingPlayer)}
          testing={testingPlayer}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1">
          <input type="radio" checked={mode === "play"} onChange={() => setMode("play")} />
          自己玩
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={mode === "spectate"} onChange={() => setMode("spectate")} />
          观战（双 agent）
        </label>
        <input
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 placeholder:text-zinc-600"
          placeholder="题材（留空随机）"
          value={genre}
          onChange={(e) => setGenre(e.target.value)}
        />
        <input
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 placeholder:text-zinc-600"
          placeholder="主角（留空代拟）"
          value={protagonist}
          onChange={(e) => setProtagonist(e.target.value)}
        />
        <select
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1"
          value={difficulty}
          onChange={(e) => setDifficulty(e.target.value as GameSetup["difficulty"])}
        >
          <option value="easy">轻松 · 0.8%</option>
          <option value="standard">标准 · 1.0%</option>
          <option value="hard">残酷 · 1.2%</option>
        </select>
        <button
          className="rounded bg-amber-700 px-3 py-1 font-medium hover:bg-amber-600 disabled:opacity-40"
          onClick={startGame}
          disabled={busy || !gmConfig.baseURL || (mode === "spectate" && !playerConfig.baseURL)}
        >
          {busy ? "进行中…" : "开始"}
        </button>
        {busy && (
          <button
            className="rounded bg-zinc-700 px-3 py-1 hover:bg-zinc-600"
            onClick={() => engineRef.current?.stop()}
          >
            停止
          </button>
        )}
      </div>

      <div
        ref={logRef}
        className="flex min-h-96 flex-col gap-4 overflow-y-auto rounded border border-zinc-800 p-4"
      >
        {entries.map((e, i) => {
          if (e.kind === "scene") {
            return (
              <section key={i} className="whitespace-pre-wrap leading-relaxed">
                {e.narration}
              </section>
            );
          }
          if (e.kind === "action") {
            return (
              <section key={i} className="border-l-2 border-amber-700 pl-3 text-amber-200">
                <span className="mr-2 text-xs text-zinc-500">
                  {e.by === "human" ? "你的行动" : "玩家 agent"}
                </span>
                {e.text}
              </section>
            );
          }
          if (e.kind === "ending") {
            return (
              <section key={i} className="rounded border border-amber-800 bg-amber-950/30 p-3">
                <h2 className="mb-2 font-bold text-amber-300">{e.title}</h2>
                <div className="whitespace-pre-wrap text-sm leading-relaxed">{e.yearbook}</div>
              </section>
            );
          }
          return (
            <section key={i} className="text-red-400">
              ⚠ {e.text}
            </section>
          );
        })}
        {streaming !== null && (
          <section className="whitespace-pre-wrap leading-relaxed text-zinc-300">
            {streaming}
            <span className="animate-pulse">▌</span>
          </section>
        )}
      </div>

      {mode === "play" && waitingInput && !gameOver && lastScene && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {lastScene.options.map((o, i) => (
              <button
                key={i}
                className="rounded border border-zinc-700 px-3 py-1 text-sm hover:border-amber-600 hover:text-amber-300"
                onClick={() => act(o)}
              >
                {o}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 placeholder:text-zinc-600"
              placeholder="或者自由输入任何行动…"
              value={freeInput}
              onChange={(e) => setFreeInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && freeInput.trim()) {
                  act(freeInput.trim());
                  setFreeInput("");
                }
              }}
            />
            <button
              className="rounded bg-zinc-700 px-3 py-1 hover:bg-zinc-600 disabled:opacity-40"
              disabled={!freeInput.trim()}
              onClick={() => {
                act(freeInput.trim());
                setFreeInput("");
              }}
            >
              发送
            </button>
          </div>
        </div>
      )}

      {mode === "spectate" && gmState && (
        <details className="rounded border border-zinc-800 p-3 text-xs text-zinc-400">
          <summary className="cursor-pointer select-none">
            GM 隐藏状态（观战者全知视角）——世界线 {gmState.worldline} · 变动率{" "}
            {gmState.divergence.toFixed(6)}% / 壁垒 {gmState.barrier.toFixed(6)}%
          </summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">
            {JSON.stringify(gmState, null, 2)}
          </pre>
        </details>
      )}
    </main>
  );
}
