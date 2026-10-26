import { createInterrupt, resolveInterrupt, dismissInterrupt, pendingInterrupts, RESPONSE_SCHEMAS, type InterruptKind } from "./interrupts.js";
import { listCheckpoints } from "./checkpoints.js";
import { loadConfig } from "../../config.js";

type GateKind = Extract<InterruptKind, "ask_user" | "plan_approval" | "tool_approval">;

/** Persist a gate the in-memory store just created. Never throws: a DB error must not block the gate. */
export function persistGate(kind: GateKind, id: string, taskId: string, payload: unknown, ttlMs: number): void {
  try {
    const cfg = loadConfig().orchestration;
    createInterrupt({
      interruptId: id,
      taskId,
      kind,
      payload,
      responseSchema: RESPONSE_SCHEMAS[kind],
      ttlMs,
      maxPendingPerTask: cfg?.interrupts.maxPendingPerTask ?? 20,
      checkpointId: listCheckpoints(taskId, 1)[0]?.checkpointId,
    });
  } catch {
    /* durable copy is best-effort; the live gate still works */
  }
}

export function settleGate(id: string, response: unknown | undefined): void {
  try {
    if (response === undefined) dismissInterrupt(id, "user");
    else resolveInterrupt(id, response, "user");
  } catch {
    /* same rule */
  }
}

/** At boot: records the in-memory stores must re-create so existing cards and routes work. */
export function gatesToRehydrate(kind: GateKind): Array<{ id: string; taskId: string; payload: unknown; expiresAt: number }> {
  return pendingInterrupts()
    .filter((r) => r.kind === kind)
    .map((r) => ({ id: r.interruptId, taskId: r.taskId, payload: r.payload, expiresAt: r.expiresAt }));
}
