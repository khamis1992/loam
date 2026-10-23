/**
 * Neo N7: branch fan-out.
 *
 * A `fanout` step runs N independent branches as child subagents in parallel,
 * bounded by the process-wide child semaphore (`SubagentRegistry`), and each
 * branch owns its own subtree on the run graph. A `merge` step then consumes
 * every branch and produces one merged result.
 *
 * Two batch variants are supported by the same core:
 *   - N prompts: one branch per prompt (a decomposition the caller chose);
 *   - N models: one branch per model (the same prompt under several models).
 *
 * Design constraints that shaped this file:
 *
 *  - The core has no model and no network dependency. The branch runner and the
 *    merger are injected, so the acceptance tests run fully offline with a fake
 *    runner and a fake graph.
 *  - Concurrency is bounded by the same semaphore that bounds `delegate_task`, so
 *    a fan-out can never spawn more children than the configured cap, and the
 *    cap is respected across every fan-out in the process at once.
 *  - A branch failure is reported, never fatal: one failing branch does not fail
 *    the others, and the merge still runs over the branches that succeeded.
 *  - Cancellation stops the fan-out: no new branch starts after the signal aborts.
 */

import type { Emit } from "./events.js";
import { createFanoutBranch, createFanoutMerge } from "./runGraphAdapter.js";
import type { SubagentRegistry } from "../subagent/registry.js";
import { registry as subagentRegistry } from "../subagent/registry.js";

/** Hard ceiling on branches per fan-out, so a runaway call cannot flood the run. */
export const FANOUT_MAX_BRANCHES = 32;
/** Default branch count when the caller does not choose one. */
export const FANOUT_DEFAULT_BRANCHES = 4;

/** One branch of a fan-out. */
export interface FanoutBranchSpec {
  /** Zero-based index within the fan-out. */
  index: number;
  /** The self-contained prompt this branch runs. */
  prompt: string;
  /** Optional model override for this branch (the N-models variant). */
  model?: string;
  /** Optional human-readable label (defaults to the prompt or model). */
  label?: string;
}

/** The result of one branch, as reported by the injected runner. */
export interface FanoutBranchRunResult {
  ok: boolean;
  text: string;
  steps?: number;
  toolCalls?: number;
  error?: string;
}

/** Context handed to a branch runner. */
export interface FanoutBranchContext {
  signal?: AbortSignal;
  taskId?: string;
  fanoutId: string;
  emit?: Emit;
}

/** Runs one branch. Injected so the core stays model-free and testable. */
export type FanoutBranchRunner = (
  branch: FanoutBranchSpec,
  ctx: FanoutBranchContext,
) => Promise<FanoutBranchRunResult>;

/** Input handed to the merge step. */
export interface FanoutMergeInput {
  goal: string;
  branches: FanoutBranchResult[];
  /** Branch indices that failed and produced no usable result. */
  failedIndexes: number[];
}

/** Merges the branch results into one answer. Injected. */
export type FanoutMerger = (input: FanoutMergeInput, ctx: FanoutBranchContext) => Promise<string>;

/** The canvas seam the core uses to open branch subtrees and the merge node. */
export interface FanoutGraph {
  createBranch(runId: string, fanoutId: string, index: number, label: string, parentNodeId?: string): { id: string };
  createMerge(runId: string, fanoutId: string, branchNodeIds: string[], summary: string, parentNodeId?: string): { id: string };
}

/** The live adapter is the default graph seam; tests inject a fake. */
const liveGraph: FanoutGraph = {
  createBranch: (runId, fanoutId, index, label, parentNodeId) =>
    createFanoutBranch(runId, fanoutId, index, label, parentNodeId),
  createMerge: (runId, fanoutId, branchNodeIds, summary, parentNodeId) =>
    createFanoutMerge(runId, fanoutId, branchNodeIds, summary, parentNodeId),
};

/** One finished branch. */
export interface FanoutBranchResult {
  index: number;
  ok: boolean;
  text: string;
  nodeId: string;
  steps: number;
  toolCalls: number;
  error?: string;
}

/** The whole fan-out: every branch plus the merged answer. */
export interface FanoutReport {
  fanoutId: string;
  /** Branches that were started, in index order. */
  branches: FanoutBranchResult[];
  /** Branch indices that failed (no usable result). */
  failedIndexes: number[];
  /** The merged result. */
  summary: string;
  /** Run-graph node id of the merge node. */
  mergeNodeId: string;
  ok: boolean;
}

export interface FanoutRunOptions {
  runId: string;
  fanoutId: string;
  /** The goal the merge step answers; also the fan-out's own instruction. */
  goal: string;
  branches: FanoutBranchSpec[];
  runner: FanoutBranchRunner;
  emit: Emit;
  /** Merge implementation; defaults to a model-free deterministic merge. */
  merger?: FanoutMerger;
  /** Child-concurrency bound. Defaults to the process-wide subagent registry. */
  registry?: SubagentRegistry;
  /** Parent node the branches hang off (defaults to the running step). */
  parentNodeId?: string;
  signal?: AbortSignal;
  taskId?: string;
  graph?: FanoutGraph;
}

function clampBranches(count: number): number {
  if (!Number.isFinite(count)) return 1;
  return Math.max(1, Math.min(FANOUT_MAX_BRANCHES, Math.trunc(count)));
}

/** Trim a caller-supplied branch list to the supported bounds. */
export function normalizeBranches(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const value = item.trim();
    if (!value) continue;
    out.push(value);
    if (out.length >= FANOUT_MAX_BRANCHES) break;
  }
  return out;
}

/**
 * Model-free merge. Used when no merger is injected and as the deterministic
 * fallback when the injected merger fails, so a fan-out always returns a result.
 */
export function deterministicMerge(input: FanoutMergeInput): string {
  const lines: string[] = [`Merged result for: ${input.goal}`, ""];
  const usable = input.branches.filter((branch) => branch.ok && branch.text.trim().length > 0);
  if (usable.length === 0) {
    lines.push("No branch returned a usable result.");
  } else {
    lines.push(`${usable.length} branch(es) completed.`);
    lines.push("");
    for (const branch of usable) {
      lines.push(`## Branch ${branch.index + 1}`);
      lines.push(branch.text.trim());
      lines.push("");
    }
  }
  if (input.failedIndexes.length > 0) {
    lines.push(`Failed branch(es): ${input.failedIndexes.map((index) => index + 1).join(", ")}`);
  }
  return lines.join("\n").trim();
}

/**
 * Run a fan-out: open one branch subtree per spec, run them in parallel under
 * the child semaphore, then merge the results into one answer.
 *
 * The branch nodes are created up front so the canvas shows N parallel roots
 * before the first child even starts, and each branch's node id is carried
 * through to the merge node so the merge cites every branch it consumed.
 */
export async function runFanout(options: FanoutRunOptions): Promise<FanoutReport> {
  const branches = options.branches.slice(0, clampBranches(options.branches.length));
  if (branches.length === 0) throw new Error("fanout requires at least one branch");
  const graph = options.graph ?? liveGraph;
  const semaphore = options.registry ?? subagentRegistry;
  const ctx: FanoutBranchContext = {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.taskId ? { taskId: options.taskId } : {}),
    fanoutId: options.fanoutId,
    emit: options.emit,
  };

  const results: FanoutBranchResult[] = new Array(branches.length);
  let cursor = 0;

  const runOne = async (branch: FanoutBranchSpec): Promise<void> => {
    const label = branch.label ?? branch.model ?? branch.prompt;
    // The branch root exists before the child starts, so the canvas can render
    // the fan-out shape while the branches are still in flight.
    const node = graph.createBranch(options.runId, options.fanoutId, branch.index, label, options.parentNodeId);
    options.emit({
      type: "fanout_branch",
      fanoutId: options.fanoutId,
      index: branch.index,
      phase: "start",
      nodeId: node.id,
      label,
    });

    let run: FanoutBranchRunResult;
    try {
      run = await options.runner(branch, ctx);
    } catch (err) {
      run = { ok: false, text: "", error: err instanceof Error ? err.message : String(err) };
    }

    const ok = run.ok && run.text.trim().length > 0;
    results[branch.index] = {
      index: branch.index,
      ok,
      text: run.text,
      nodeId: node.id,
      steps: run.steps ?? 0,
      toolCalls: run.toolCalls ?? 0,
      ...(run.error ? { error: run.error } : {}),
    };
    options.emit({
      type: "fanout_branch",
      fanoutId: options.fanoutId,
      index: branch.index,
      phase: "done",
      nodeId: node.id,
      label,
      summary: ok ? `branch ${branch.index + 1} finished` : `branch ${branch.index + 1} failed: ${run.error ?? "empty result"}`,
    });
  };

  // Workers pull the next branch in order and stop when the run is cancelled.
  // The semaphore is acquired per branch, so the number of children in flight is
  // never above the configured cap even when several fan-outs run at once.
  const worker = async (): Promise<void> => {
    while (cursor < branches.length) {
      if (options.signal?.aborted) break;
      const branch = branches[cursor]!;
      cursor += 1;
      const release = await semaphore.acquireChild();
      try {
        await runOne(branch);
      } finally {
        release();
      }
    }
  };

  const workerCount = Math.min(semaphore.maxConcurrentChildren, branches.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  const finished = branches.map((_, index) => results[index]).filter((result): result is FanoutBranchResult => Boolean(result));
  const failedIndexes = finished.filter((branch) => !branch.ok).map((branch) => branch.index);

  let summary = "";
  try {
    summary = await (options.merger ?? deterministicMerge)(
      { goal: options.goal, branches: finished, failedIndexes },
      ctx,
    );
  } catch {
    summary = "";
  }
  if (!summary.trim()) summary = deterministicMerge({ goal: options.goal, branches: finished, failedIndexes });

  const mergeNodeId = graph.createMerge(
    options.runId,
    options.fanoutId,
    finished.map((branch) => branch.nodeId),
    summary,
    options.parentNodeId,
  ).id;
  options.emit({
    type: "fanout_merge",
    fanoutId: options.fanoutId,
    branchNodeIds: finished.map((branch) => branch.nodeId),
    summary,
  });

  return {
    fanoutId: options.fanoutId,
    branches: finished,
    failedIndexes,
    summary,
    mergeNodeId,
    ok: finished.length > failedIndexes.length,
  };
}
