/**
 * C11: one worker turn over Loam's single-agent runtime (runAgent, src/agent/loop.ts).
 * The worker gets a per-turn registry built like SwarmService builds a stage registry
 * (src/swarm/service.ts): named tools, each wrapped to stop on cancel and to stay
 * inside the worker's worktree, plus the seven board tools passed as extraAllow.
 */
import type { Config } from "../../config.js";
import type { OllamaClient } from "../../ollama.js";
import type { WorkerCheckpoint } from "../../agent/checkpoint.js";
import type { Usage } from "../../agent/events.js";
import type { RunOptions, RunResult } from "../../agent/loop.js";
import { ToolRegistry, type Tool } from "../../tools/registry.js";
import { taskPath } from "../../server/taskWorkspace.js";
import { SPAN, LOAM, GENAI } from "../tracing/genai.js";
import { createBoardTools, type BoardToolBinding } from "./boardTools.js";
import { turnPrompt, workerSystemPrompt } from "./prompt.js";
import type { CoordinationDb } from "./board.js";
import { BOARD_TOOL_NAMES, TURN_TIMEOUT_MS, WORKER_MAX_STEPS, WORKER_TOOL_NAMES, type SwarmCorePort, type SwarmSpan, type WorkerState } from "./types.js";

export type SwarmExecutor = (o: RunOptions) => Promise<RunResult>;

export interface WorkerTurnInput {
  cfg: Config;
  ollama: OllamaClient;
  baseTools: ToolRegistry;
  executor: SwarmExecutor;
  db: CoordinationDb;
  binding: Omit<BoardToolBinding, "db" | "workerId" | "onGist">;
  worker: WorkerState;
  goal: string;
  teamSize: number;
  model: string;
  taskId: string;
  runId: string;
  signal: AbortSignal;
  nudge?: string;
  resume?: WorkerCheckpoint;
  saveWorker?: (cp: WorkerCheckpoint) => void;
  tracing?: SwarmCorePort["tracing"];
  parentSpan?: SwarmSpan;
  turnTimeoutMs?: number;
}

export interface WorkerTurnResult {
  gists: number;
  claims: number;
  patchSummaries: number;
  toolCalls: number;
  steps: number;
  usage: Usage;
  model: string;
  text: string;
}

const PATH_KEYS = ["path", "cwd", "directory", "dir", "file"];

/** Per-worker registry: named Loam tools confined to the worktree + board tools, filtered by build mode. */
export function buildWorkerRegistry(baseTools: ToolRegistry, worktree: string, signal: AbortSignal, boardTools: Tool[], onCall: (name: string) => (() => void) | void): ToolRegistry {
  const registry = new ToolRegistry();
  const wrap = (tool: Tool, confine: boolean): Tool => ({
    ...tool,
    run: async (args, ctx) => {
      if (signal.aborted) throw new Error("Run cancelled");
      if (confine) for (const k of PATH_KEYS) if (typeof args[k] === "string" && args[k]) taskPath(worktree, args[k] as string);
      const done = onCall(tool.name);
      try {
        return await tool.run(args, { ...ctx, workspace: worktree });
      } finally {
        done?.();
      }
    },
  });
  for (const name of WORKER_TOOL_NAMES) {
    const t = baseTools.get(name);
    if (t) registry.register(wrap(t, true));
  }
  for (const t of boardTools) registry.register(wrap(t, false));
  return registry.forMode("build", [...BOARD_TOOL_NAMES]);
}

export async function runWorkerTurn(i: WorkerTurnInput): Promise<WorkerTurnResult> {
  const w = i.worker;
  const turn = w.turns + 1;
  const counts = { gists: 0, claims: 0, patchSummaries: 0, toolCalls: 0 };
  const turnSpan = i.tracing?.startSpan(SPAN.swarmTurn, { [LOAM.swarmRunId]: i.runId, [LOAM.swarmWorkerId]: w.id, [LOAM.swarmTurn]: turn }, i.parentSpan);
  const boardTools = createBoardTools({
    ...i.binding,
    db: i.db,
    workerId: w.id,
    onGist: (type) => {
      counts.gists++;
      if (type === "CLAIM") counts.claims++;
      if (type === "PATCH_SUMMARY") counts.patchSummaries++;
    },
  });
  const turnSignal = AbortSignal.any([i.signal, AbortSignal.timeout(i.turnTimeoutMs ?? TURN_TIMEOUT_MS)]);
  const tools = buildWorkerRegistry(i.baseTools, w.worktree, turnSignal, boardTools, (name) => {
    counts.toolCalls++;
    const span = i.tracing?.startSpan(SPAN.toolCall, { [GENAI.toolName]: name, [LOAM.swarmWorkerId]: w.id }, turnSpan);
    return () => span?.end();
  });
  const board = i.db.boardRead().rendered;
  i.db.markBoardSeen(w.id);
  const channel = i.db.drainChannel(w.id);
  const cfg: Config = { ...i.cfg, model: i.model, workspace: w.worktree, policy: { ...i.cfg.policy, allowOutsideWorkspaceRead: false } };
  try {
    const res = await i.executor({
      cfg,
      ollama: i.ollama,
      tools,
      emit: () => undefined,
      prompt: turnPrompt({ goal: i.goal, turn, board, channel, ...(i.nudge ? { nudge: i.nudge } : {}) }),
      signal: turnSignal,
      taskId: i.taskId,
      sessionId: `realswarm-${i.runId}-${w.id}-${turn}`,
      systemOverride: workerSystemPrompt({ workerId: w.id, goal: i.goal, teamSize: i.teamSize, worktree: w.worktree }),
      maxSteps: WORKER_MAX_STEPS,
      model: i.model,
      suppressFinal: true,
      ...(i.resume ? { resumeWorker: i.resume } : {}),
      ...(i.saveWorker ? { saveWorker: (cp: WorkerCheckpoint | undefined) => { if (cp) i.saveWorker!(cp); } } : {}),
    });
    turnSpan?.end({ [GENAI.inputTokens]: res.usage.promptTokens, [GENAI.outputTokens]: res.usage.completionTokens, "loam.swarm.gists": counts.gists });
    return { ...counts, steps: res.steps, usage: res.usage, model: res.model, text: res.text };
  } catch (err) {
    turnSpan?.end(undefined, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
