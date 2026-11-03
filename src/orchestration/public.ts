/**
 * The stable consumer API of the Orchestration Core. Consumers (the C11 coding
 * team through swarm/corePort.ts, atoms-dev Race, devin-vuln-fixes gates)
 * import from here only, never from inner files.
 */
import { append } from "../protocol/eventLog.js";
import type { OrchestrationCore } from "./core.js";
import { indexCheckpoint, listCheckpoints, type CheckpointRef } from "./durable/checkpoints.js";
import { callStructured } from "./contracts/structured.js";
import { LEDGER_SCHEMA, ledgerMessages, EMPTY_LEDGER, type LedgerEntry } from "./ledger/progressLedger.js";
import { selectBest, type Candidate, type CandidateCheck, type SelectResult } from "./selection/selectBest.js";

export { selectBest, type Candidate, type SelectResult } from "./selection/selectBest.js";
export { createInterrupt, waitForInterrupt, resolveInterrupt, pendingInterrupts, RESPONSE_SCHEMAS, type InterruptRecord } from "./durable/interrupts.js";
export { guardUntrusted } from "./contracts/injectionGuard.js";
export { callStructured } from "./contracts/structured.js";
export { scoreTrajectory } from "./evals/trajectory.js";

/** Index a checkpoint the run already appended to the event log. logSeq 0 = the append failed: skip. */
export function recordCheckpoint(core: OrchestrationCore, taskId: string, sessionId: string, cp: { round: number; nextStep: number; completed: unknown[]; complete?: boolean }, logSeq: number): CheckpointRef | undefined {
  if (logSeq <= 0) return undefined;
  return indexCheckpoint({ taskId, sessionId, logSeq, cp, keep: core.cfg.durability.keepCheckpointsPerRun });
}

/**
 * Keyed checkpoints for consumers that are not orchestrator runs
 * (Agensh key `realswarm/<runId>/<workerId>`). Body goes to the event log
 * like every other checkpoint; the index row makes it listable.
 */
export function saveKeyedCheckpoint(core: OrchestrationCore, key: string, body: { round?: number; nextStep?: number; steps?: number }, revision: number): CheckpointRef | undefined {
  const ev = append(key, "checkpoint", body, { idempotencyKey: `kcp:${revision}` });
  return recordCheckpoint(core, key, key, { round: body.round ?? 0, nextStep: body.nextStep ?? body.steps ?? revision, completed: [] }, ev.seq);
}

export function loadLatestKeyedCheckpoint(core: OrchestrationCore, key: string): unknown {
  const ref = listCheckpoints(key, 1)[0];
  return ref ? core.readCheckpoint(ref.sessionId, ref.logSeq) : undefined;
}

/** One stateless progress judgement (Agensh idle-nudge signal). Undefined when no cloud model or the call failed. */
export async function judgeProgress(core: OrchestrationCore, input: { goal: string; recentDigest: string; context?: string }): Promise<Pick<LedgerEntry, "progressing" | "inLoop" | "instruction"> | undefined> {
  const model = core.modelFor("ledger");
  if (!model) return undefined;
  const r = await callStructured<LedgerEntry>(core.port, {
    model,
    contract: "progress_judgement",
    schema: LEDGER_SCHEMA,
    messages: ledgerMessages({ goal: input.goal, planSteps: [{ id: "work", title: input.context ?? "current work", status: "doing" }], recentDigest: input.recentDigest }, EMPTY_LEDGER, core.cfg.ledger.maxLedgerChars),
    repairAttempts: core.cfg.contracts.repairAttempts,
  });
  return r.ok ? { progressing: r.value.progressing, inLoop: r.value.inLoop, instruction: r.value.instruction } : undefined;
}

/** selectBest bound to the core's cloud judge (undefined judge = no cloud model: majority/first fallback). */
export function selectWithCore(core: OrchestrationCore, goal: string, candidates: Candidate[], check?: CandidateCheck, signal?: AbortSignal): Promise<SelectResult> {
  const model = core.modelFor("selection");
  return selectBest({
    goal,
    candidates,
    maxCandidates: core.cfg.selection.maxCandidates,
    check: core.cfg.selection.runRegressionChecks ? check : undefined,
    judge: model ? { port: core.port, model, votes: 3, repairAttempts: core.cfg.contracts.repairAttempts } : undefined,
    signal,
  });
}
