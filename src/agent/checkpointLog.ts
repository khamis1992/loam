/**
 * Checkpoint + tool lifecycle events in the durable event log (BUILD_SPEC §6.5).
 *
 * The orchestrator's `ExecutionCheckpoint` is persisted in the `entities` table
 * (the `SavedRun`), but that write is only reachable through the agent entry
 * point. These helpers append the same state to the append-only
 * `session_events` log so a reader can reconstruct exactly what happened:
 *
 * - `writeCheckpoint` stores the checkpoint and returns the log sequence it got.
 * - `recordToolCall` / `recordToolResult` bracket every tool call with a
 *   `tool_result` event before and after it runs, so a call that started without
 *   reaching a terminal state is visible after a crash.
 *
 * Both are fail-safe: a logging problem must never break the task, so every
 * append is caught and warned instead of thrown. Payloads never contain raw tool
 * arguments (BUILD_SPEC §10) — a `secret` tool (classified by
 * `src/policy/riskTier.ts`) records only a redaction marker as its brief.
 */
import { append, after, lastOfKind, type LogKind } from "../protocol/eventLog.js";
import type { ExecutionCheckpoint } from "./checkpoint.js";
import { classifyToolCall } from "../policy/riskTier.js";
import { log, redact } from "../log.js";

/** State of one tool call as stored in the log. */
export type ToolCallState = "started" | "succeeded" | "failed" | "canceled";

export interface ToolResultPayload {
  toolCallId: string;
  name: string;
  state: ToolCallState;
  /** Short output summary. Omitted for secret tools; never raw arguments. */
  brief?: string;
}

/** A tool call seen in the log, with the sequence of the row that reported it. */
export interface ToolCallRecord {
  toolCallId: string;
  name: string;
  state: ToolCallState;
  seq: number;
}

/** Terminal states of a tool call. A `started` row is in flight until one lands. */
export const TERMINAL_TOOL_STATES: readonly ToolCallState[] = ["succeeded", "failed", "canceled"];

/** True when `state` ends a call's lifecycle. */
export function isTerminalToolState(state: string): boolean {
  return (TERMINAL_TOOL_STATES as readonly string[]).includes(state);
}

function safeAppend<P>(
  sessionId: string,
  kind: LogKind,
  payload: P,
  opts: { turnId?: string; idempotencyKey?: string },
): number {
  try {
    return append(sessionId, kind, payload, opts).seq;
  } catch (err) {
    // Durability must never break the run: log the failure and keep going.
    log.warn(`checkpoint log: failed to append ${kind}: ${String(err)}`);
    return 0;
  }
}

/**
 * Identity of a checkpoint for idempotency. Two saves with the same identity are
 * the same checkpoint and must not be written twice.
 *
 * The spec's key is `cp:{round}:{nextStep}:{trace.length}`; the two boolean flags
 * are added because a checkpoint with the same counters but a different
 * `inFlight`/`complete` is a *different* state, and O6b decides whether a run may
 * auto-resume from exactly that flag. Without them the newest state could be
 * hidden behind an older row that happens to share the counters.
 */
function checkpointKey(cp: ExecutionCheckpoint): string {
  return `cp:${cp.round}:${cp.nextStep}:${cp.trace.length}:${cp.inFlight ? 1 : 0}:${cp.complete ? 1 : 0}`;
}

/**
 * Append the checkpoint to the log and return the sequence it received.
 *
 * `logSeq` is deliberately stripped from the payload: it is assigned *after* the
 * write, so storing the value the caller had before would be stale.
 */
export function writeCheckpoint(sessionId: string, cp: ExecutionCheckpoint, turnId?: string): number {
  const { logSeq: _ignored, ...payload } = cp;
  return safeAppend(sessionId, "checkpoint", payload, { turnId, idempotencyKey: checkpointKey(cp) });
}

/** Read the newest checkpoint event back (and the sequence it was written at). */
export function readLatestCheckpoint(sessionId: string): { cp: ExecutionCheckpoint; seq: number } | undefined {
  // `lastOfKind` returns an untyped `LogEvent`, so the payload is narrowed here
  // rather than trusting the caller.
  const ev = lastOfKind(sessionId, "checkpoint");
  return ev ? { cp: ev.payload as ExecutionCheckpoint, seq: ev.seq } : undefined;
}

function toolKey(toolCallId: string, state: string): string {
  return `tool:${toolCallId}:${state}`;
}

/**
 * Record that a tool call is about to run. Call this immediately BEFORE the
 * effect happens so a crash inside the tool still leaves a `started` row.
 */
export function recordToolCall(sessionId: string, toolCallId: string, name: string, turnId?: string): void {
  const payload: ToolResultPayload = { toolCallId, name, state: "started" };
  safeAppend(sessionId, "tool_result", payload, { turnId, idempotencyKey: toolKey(toolCallId, "started") });
}

/**
 * Record the outcome of a tool call. `secret` tools keep only a redaction marker
 * as their brief, and every other brief is passed through the same redactor the
 * logger uses; nothing else in the payload stores arguments.
 */
export function recordToolResult(
  sessionId: string,
  toolCallId: string,
  name: string,
  state: ToolCallState,
  brief: string,
  turnId?: string,
  workspaceRoot?: string,
): void {
  const secret = classifyToolCall(name, undefined, workspaceRoot ?? process.cwd()) === "secret";
  const payload: ToolResultPayload = {
    toolCallId,
    name,
    state,
    brief: secret ? "[redacted]" : redact(brief.slice(0, 2000)),
  };
  safeAppend(sessionId, "tool_result", payload, { turnId, idempotencyKey: toolKey(toolCallId, state) });
}

/** All `tool_result` events recorded for a session, oldest first. */
function toolEvents(sessionId: string): Array<{ payload: ToolResultPayload; seq: number }> {
  try {
    return after(sessionId, 0, 5000)
      .filter((e) => e.kind === "tool_result")
      .map((e) => ({ payload: e.payload as ToolResultPayload, seq: e.seq }));
  } catch (err) {
    log.warn(`checkpoint log: failed to read tool events: ${String(err)}`);
    return [];
  }
}

/**
 * Tool calls whose `started` row has no terminal row yet — the in-flight set.
 *
 * A crash (or a user cancel) between `recordToolCall` and `recordToolResult`
 * leaves exactly this situation, and it is why a resumed run may not silently
 * re-run a side-effecting tool.
 */
export function inFlightToolCalls(sessionId: string): ToolCallRecord[] {
  const events = toolEvents(sessionId);
  const finished = new Set<string>();
  for (const { payload } of events) {
    if (isTerminalToolState(payload.state)) finished.add(payload.toolCallId);
  }
  const seen = new Set<string>();
  const inFlight: ToolCallRecord[] = [];
  for (const { payload, seq } of events) {
    if (payload.state !== "started") continue;
    if (finished.has(payload.toolCallId) || seen.has(payload.toolCallId)) continue;
    seen.add(payload.toolCallId);
    inFlight.push({ toolCallId: payload.toolCallId, name: payload.name, state: payload.state, seq });
  }
  return inFlight;
}

/**
 * True when the log shows a tool call that started but never reached a terminal
 * state. An unknown session (or a run that never logged) answers `false`, so the
 * caller falls back to the checkpoint's own `inFlight` flag.
 */
export function hasUnfinishedToolCall(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return inFlightToolCalls(sessionId).length > 0;
}
