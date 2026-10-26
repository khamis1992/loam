/**
 * C11 self-organizing coding team (RealSwarm): all types and constants.
 * Clean-room design modelled on the coordination ideas of Agensh (Microsoft
 * Research, MIT; arXiv:2609.26781). No Agensh source is copied.
 */
import type { WorkerCheckpoint } from "../../agent/checkpoint.js"; // OBSERVED: src/agent/checkpoint.ts

/** Coordination note types: the same five types as Agensh's board (OBSERVED shared_lessons.py:14). */
export type BoardNoteType = "FACT" | "OBSERVED" | "FAIL" | "CLAIM" | "PATCH_SUMMARY";
export const BOARD_NOTE_TYPES: readonly BoardNoteType[] = ["FACT", "OBSERVED", "FAIL", "CLAIM", "PATCH_SUMMARY"];

export const MAX_CONTENT_CHARS = 100;          // OBSERVED shared_lessons.py:15
export const MAX_PATCH_SUMMARY_CHARS = 300;    // OBSERVED shared_lessons.py:16
export const MAX_DETAIL_CHARS = 8000;          // Loam bound for the unfoldable long form
export const MAX_BOARD_ENTRIES = 2000;         // in-memory admission window
export const DEFAULT_CLAIM_TTL_SECONDS = 3600; // OBSERVED shared_lessons.py:23, main.py:42
export const CLAIM_OVERLAP_JACCARD = 0.6;      // Loam choice for the overlap notice (INFERRED)

/** Event-queue backoff (OBSERVED Agensh mini-router state.ts). */
export const RETRY_BACKOFF_MS: readonly number[] = [1_000, 5_000, 30_000, 120_000];
export const MAX_ATTEMPTS = 5;

/** Hard limits. Shipped defaults live in orchestration.swarm (config.ts) and are clamped to these. */
export const HARD_MAX_WORKERS = 16;            // OD-8
export const REALSWARM_LANES = 1;              // runs executing at once (SwarmService uses 2)
export const MAX_ACTIVE_REALSWARM_RUNS = 2;    // queued + running cap
export const GIT_TIMEOUT_MS = 15_000;          // per git call, as SwarmService.capture
export const MAX_TURNS_PER_WORKER = 200;       // safety stop even before the deadline
export const WORKER_MAX_STEPS = 30;            // runAgent maxSteps per worker turn
export const TURN_TIMEOUT_MS = 1_200_000;      // per-turn timeout (Agensh ACP-silence watchdog, 20 min)

/** Tools bound per worker; passed as extraAllow to forMode("build", ...). */
export const BOARD_TOOL_NAMES = [
  "board_write", "board_read", "board_grep", "board_unfold",
  "swarm_message", "swarm_inbox", "merge_request",
] as const;
export type BoardToolName = (typeof BOARD_TOOL_NAMES)[number];

/** Loam tools a worker may use, all confined to its own worktree (OD-12). */
export const WORKER_TOOL_NAMES = [
  "file_read", "file_list", "file_search", "file_stat", "grep", "glob",
  "code_symbols", "code_outline", "semantic_search",
  "file_write", "file_edit", "file_mkdir", "shell_run",
  "git_status_diff", "git_commit", "git_branch",
] as const;

export type WorkerStatus = "queued" | "running" | "idle" | "completed" | "failed" | "cancelled" | "interrupted";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface BoardNote {
  thread_id: string;          // author worker id; "harness" for the seeded goal
  type: BoardNoteType | string;
  content: string;
  work_label?: string;        // author-chosen sub-task slug
  detail?: string;            // long form behind the G-label (board_unfold)
  ttl_seconds?: number;       // CLAIM only
}

export interface BoardEntry {
  id: number;                 // DB row id, rendered as "G<id>"
  label: string;
  thread_id: string;
  type: BoardNoteType;
  content: string;
  work_label?: string;
  ts: number;                 // epoch seconds
  expires_at?: number | null; // CLAIM only
  has_detail: boolean;
  verified_checkpoint?: boolean;
  invalidated_by_fail?: string;
  local_failures?: number;
  /** CLAIM only: "PATCH_SUMMARY" or "FAIL" when the author closed it (Loam addition, U12). */
  closed_by?: string;
  dup?: number;
  first_ts?: number;
  last_ts?: number;
}

export interface BoardWriteResult {
  status: "admitted" | "rejected";
  reason?: string;
  gist_id?: number;
  label?: string;
  /** CLAIM only: an active overlapping claim held by another worker. */
  overlap?: { label: string; holder: string; work_label?: string };
}

export interface MailboxMessage {
  id: number;
  from: string;
  to: string | null;          // null = team channel
  body: string;
  ts: number;
}

export type SwarmEventKind = "turn" | "idle_nudge" | "forced_write" | "merge_conflict";
export type SwarmEventState = "pending" | "sending" | "sent" | "failed";

export interface SwarmEvent {
  id: number;
  worker: string;
  kind: SwarmEventKind;
  payload: Record<string, unknown>;
  state: SwarmEventState;
  attempts: number;
  created_at: number;         // epoch ms
  next_retry_at: number | null;
  last_error?: string | null;
}

export interface SwarmUsage { promptTokens: number; completionTokens: number; durationMs: number; modelCalls: number }

export interface WorkerState {
  id: string;                 // "w1".."w16"
  status: WorkerStatus;
  worktree: string;           // <runRoot>/.loam/realswarm/workers/<id>
  branch?: string;            // current worker/<id>/<label>
  checkpointKey: string;      // realswarm/<runId>/<id>
  startedAt?: string;
  lastActivityAt?: string;
  currentClaimLabel?: string;
  turns: number;
  toolCalls: number;
  attempts: number;           // consecutive failed turn attempts
  usage: SwarmUsage;
  error?: string;
}

export interface RealSwarmMergeInfo {
  worker: string;
  branch: string;
  label: string;
  changedFiles: number;       // from git diff --name-only main...branch
  conflictsResolved: string[];
  mergedAt: string;
  commit: string;             // merge commit sha from git
}

export interface RealSwarmMetrics {
  claimsOpened: number;
  claimsActive: number;
  claimsExpired: number;
  patchSummaries: number;
  patchVerified: number;
  patchInvalidated: number;
  failsRecorded: number;
  factsRecorded: number;
  mergesLanded: number;
  conflictsResolved: number;
  mainCommits: number;
  messagesChannel: number;
  messagesDirect: number;
}

export interface RealSwarmSnapshot {
  id: string;                 // realswarm_<uuid>
  taskId: string;
  workspace: string;          // run root (git repo, main checked out)
  goal: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  model: string;
  maxWorkers: number;
  claimTtlSeconds: number;
  deadlineMs: number;
  activationStaggerMs: number;
  idleNudgeMs: number;
  repoReady: boolean;
  codeBranch: "main";
  baseRun?: string;
  workers: WorkerState[];
  merges: RealSwarmMergeInfo[];
  usage: SwarmUsage;          // only real model calls counted
  metrics: RealSwarmMetrics;  // derived from board rows and git, never literals
  events: Array<{ at: string; worker?: string; type: string; message: string }>;
  shared: { progress: boolean; checkpoints: boolean; selection: boolean; tracing: boolean };
  completionReason?: "deadline" | "quiescent" | "cancelled" | "all_workers_failed" | "turn_limit";
  traceId?: string;
  error?: string;
}

export interface CreateRealSwarmInput {
  goal: string;
  maxWorkers?: number;
  model?: string;
  claimTtlSeconds?: number;
  deadlineMs?: number;
  repoSeed?: string;          // a local folder copied into the run root before the first commit
  baseRun?: string;           // a completed run whose main is cloned
}

/* ---- Port to the other Core capabilities (C1, C2, C3, C5). Implemented by corePort.ts over
 * ---- src/orchestration/public.ts; NOOP_CORE_PORT keeps C11 runnable and testable without them. */

export interface ProgressJudgement { isInLoop: boolean; isProgressBeingMade: boolean; reason: string }

export interface SwarmCandidate {
  workerId: string;
  branch: string;
  gistLabel: string;
  evidence: string;
  diff?: string;
}

export interface SwarmSpan { readonly traceId: string; end(attrs?: Record<string, string | number | boolean>, error?: string): void }

export interface SwarmCorePort {
  progress?: { judgeProgress(input: { workerId: string; goal: string; recentTurns: string[]; boardExcerpt: string; signal?: AbortSignal }): Promise<ProgressJudgement | undefined> };
  checkpoints?: {
    saveWorker(key: string, checkpoint: WorkerCheckpoint, revision: number): void;
    loadLatestWorker(key: string): WorkerCheckpoint | undefined;
  };
  selection?: { selectBest(input: { label: string; goal: string; candidates: SwarmCandidate[]; signal?: AbortSignal }): Promise<{ chosenBranch: string | null; method: string; reason: string }> };
  tracing?: { startSpan(name: string, attrs: Record<string, string | number | boolean>, parent?: SwarmSpan): SwarmSpan };
}

export const NOOP_CORE_PORT: SwarmCorePort = {};
