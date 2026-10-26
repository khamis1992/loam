/**
 * Loam Orchestration Core: the `orchestration` config block (new key on Config).
 * Every number here is the shipped default. Loam's config loader deep-merges
 * user values over ORCHESTRATION_DEFAULTS and then calls clampOrchestration().
 */
export type DurabilityMode = "exit" | "async" | "sync";
export type InjectionStrategy = "off" | "warn" | "filter" | "block";
export type AcpPermissionDefault = "ask" | "allow_once" | "reject";

export interface OrchestrationConfig {
  tracing: {
    enabled: boolean;
    /** 0..1, decided once per trace at the root span. */
    sampleRate: number;
    retainDays: number;
    maxSpansPerTrace: number;
    /** Record prompt/completion text on spans. Off: only sizes and hashes. */
    captureContent: boolean;
    /** Empty = no export (OD-4). Only a user-typed OTLP/HTTP URL enables export. */
    otlpEndpoint: string;
  };
  durability: { mode: DurabilityMode; keepCheckpointsPerRun: number };
  interrupts: { defaultTtlMs: number; maxPendingPerTask: number };
  contracts: { repairAttempts: number; injectionGuard: InjectionStrategy; injectionThreshold: number };
  ledger: {
    enabled: boolean;
    /** Empty = orchestrator.plannerModel, then cfg.model. Must be a cloud model. */
    model: string;
    maxStallCount: number;
    maxResets: number;
    /** Run the model ledger every N worker turns even when no stuck pattern fired. */
    everyTurns: number;
    maxLedgerChars: number;
  };
  selection: { enabled: boolean; model: string; maxCandidates: number; runRegressionChecks: boolean };
  acp: {
    advertiseFs: boolean;
    advertiseTerminal: boolean;
    permissionDefault: AcpPermissionDefault;
    modelSelection: boolean;
    passMcpServers: boolean;
  };
  returnDirect: { enabled: boolean };
  workflows: { enabled: boolean; maxSupersteps: number; maxParallelNodes: number; maxNodes: number };
  evals: { trajectory: boolean; judgeModel: string };
  memoryRanking: {
    enabled: boolean;
    similarityWeight: number;
    recencyWeight: number;
    importanceWeight: number;
    recencyHalfLifeDays: number;
    candidateMultiplier: number;
  };
  /** C11 self-organizing coding team (RealSwarm). */
  swarm: {
    enabled: boolean;
    /** Workers per run (OD-8: ship 4, hard max 16). */
    maxWorkers: number;
    claimTtlSeconds: number;
    deadlineMs: number;
    idleNudgeMs: number;
    activationStaggerMs: number;
    /** Process-wide cap on concurrent worker model turns across all runs (U9). */
    maxInFlightTurns: number;
    /** OD-14: run C3 selectBest when two verified patches compete for one work label. */
    selectCompetingPatches: boolean;
    /** Ask the C1 progress judgement for a reason before an idle nudge (cloud only). */
    progressJudgement: boolean;
  };
}

export const ORCHESTRATION_DEFAULTS: OrchestrationConfig = {
  tracing: { enabled: true, sampleRate: 1, retainDays: 14, maxSpansPerTrace: 5000, captureContent: false, otlpEndpoint: "" },
  durability: { mode: "sync", keepCheckpointsPerRun: 200 },
  interrupts: { defaultTtlMs: 30 * 60_000, maxPendingPerTask: 20 },
  contracts: { repairAttempts: 1, injectionGuard: "warn", injectionThreshold: 0.6 },
  ledger: { enabled: true, model: "", maxStallCount: 3, maxResets: 2, everyTurns: 3, maxLedgerChars: 6000 },
  selection: { enabled: true, model: "", maxCandidates: 8, runRegressionChecks: true },
  acp: { advertiseFs: true, advertiseTerminal: false, permissionDefault: "ask", modelSelection: true, passMcpServers: true },
  returnDirect: { enabled: true },
  workflows: { enabled: false, maxSupersteps: 100, maxParallelNodes: 4, maxNodes: 64 },
  evals: { trajectory: true, judgeModel: "" },
  memoryRanking: {
    enabled: false,
    similarityWeight: 0.5,
    recencyWeight: 0.3,
    importanceWeight: 0.2,
    recencyHalfLifeDays: 30,
    candidateMultiplier: 3,
  },
  swarm: {
    enabled: true,
    maxWorkers: 4,
    claimTtlSeconds: 3600,
    deadlineMs: 1_800_000,
    idleNudgeMs: 600_000,
    activationStaggerMs: 3000,
    maxInFlightTurns: 4,
    selectCompetingPatches: false,
    progressJudgement: true,
  },
};

const clamp = (v: number, lo: number, hi: number, d: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

/** Bounds every numeric key so a hand-edited config cannot disable a safety limit. */
export function clampOrchestration(c: OrchestrationConfig): OrchestrationConfig {
  const d = ORCHESTRATION_DEFAULTS;
  return {
    ...c,
    tracing: {
      ...c.tracing,
      sampleRate: clamp(c.tracing.sampleRate, 0, 1, d.tracing.sampleRate),
      retainDays: clamp(c.tracing.retainDays, 1, 90, d.tracing.retainDays),
      maxSpansPerTrace: clamp(c.tracing.maxSpansPerTrace, 100, 50_000, d.tracing.maxSpansPerTrace),
    },
    durability: { ...c.durability, keepCheckpointsPerRun: clamp(c.durability.keepCheckpointsPerRun, 10, 2000, 200) },
    interrupts: {
      defaultTtlMs: clamp(c.interrupts.defaultTtlMs, 60_000, 24 * 3_600_000, d.interrupts.defaultTtlMs),
      maxPendingPerTask: clamp(c.interrupts.maxPendingPerTask, 1, 200, d.interrupts.maxPendingPerTask),
    },
    contracts: {
      ...c.contracts,
      repairAttempts: clamp(c.contracts.repairAttempts, 0, 2, 1),
      injectionThreshold: clamp(c.contracts.injectionThreshold, 0.1, 1, 0.6),
    },
    ledger: {
      ...c.ledger,
      maxStallCount: clamp(c.ledger.maxStallCount, 1, 10, 3),
      maxResets: clamp(c.ledger.maxResets, 0, 5, 2),
      everyTurns: clamp(c.ledger.everyTurns, 1, 20, 3),
      maxLedgerChars: clamp(c.ledger.maxLedgerChars, 1000, 20_000, 6000),
    },
    selection: { ...c.selection, maxCandidates: clamp(c.selection.maxCandidates, 2, 32, 8) },
    workflows: {
      ...c.workflows,
      maxSupersteps: clamp(c.workflows.maxSupersteps, 1, 1000, 100),
      maxParallelNodes: clamp(c.workflows.maxParallelNodes, 1, 8, 4),
      maxNodes: clamp(c.workflows.maxNodes, 2, 256, 64),
    },
    memoryRanking: {
      ...c.memoryRanking,
      similarityWeight: clamp(c.memoryRanking.similarityWeight, 0, 1, 0.5),
      recencyWeight: clamp(c.memoryRanking.recencyWeight, 0, 1, 0.3),
      importanceWeight: clamp(c.memoryRanking.importanceWeight, 0, 1, 0.2),
      recencyHalfLifeDays: clamp(c.memoryRanking.recencyHalfLifeDays, 1, 3650, 30),
      candidateMultiplier: clamp(c.memoryRanking.candidateMultiplier, 1, 10, 3),
    },
    swarm: {
      ...c.swarm,
      maxWorkers: Math.round(clamp(c.swarm.maxWorkers, 1, 16, 4)),
      claimTtlSeconds: clamp(c.swarm.claimTtlSeconds, 60, 86_400, 3600),
      deadlineMs: clamp(c.swarm.deadlineMs, 60_000, 14_400_000, 1_800_000),
      idleNudgeMs: clamp(c.swarm.idleNudgeMs, 10_000, 3_600_000, 600_000),
      activationStaggerMs: clamp(c.swarm.activationStaggerMs, 0, 60_000, 3000),
      maxInFlightTurns: Math.round(clamp(c.swarm.maxInFlightTurns, 1, 16, 4)),
    },
  };
}
