import { allEntities, getEntity, putEntity, removeEntity } from "./sqliteStore.js";
import { newId } from "./db.js";
import { append } from "../protocol/eventLog.js";

/**
 * Durable inbound message queue (BUILD_SPEC §6.6).
 *
 * Omnara's idea, rebuilt independently: an incoming user message is *stored*
 * first and only becomes an `input` event once the agent admits it. A busy agent
 * therefore never loses a message, and a message that arrives while the process
 * is down is still there after the restart.
 *
 * The queue lives in the existing `entities` table under the `"inputs"` kind, so
 * it survives a process restart for free. Admitting is idempotent: the input
 * event is appended with `idempotencyKey = q.id`, so a retry after a crash
 * returns the existing row instead of writing a second one.
 */

export type InputState = "received" | "admitted" | "canceled";

/** How the composer asked for the message to be delivered. */
export type InputDelivery = "queued" | "steering";

export interface QueuedInput {
  id: string;
  sessionId: string;
  text: string;
  delivery: InputDelivery;
  state: InputState;
  receivedAt: number;
  /** Log sequence of the `input` event, set when the agent admits it. */
  admittedSeq?: number;
}

/** Payload of the durable `input` event (BUILD_SPEC §7). */
export interface InputPayload {
  text: string;
  actor: "user" | "agent" | "system";
  inputId: string;
}

/** Store an inbound message. It stays `received` until the agent admits it. */
export function enqueue(i: Omit<QueuedInput, "state" | "receivedAt">): QueuedInput {
  const q: QueuedInput = { ...i, state: "received", receivedAt: Date.now() };
  putEntity("inputs", q);
  return q;
}

/** Messages still waiting for admission, oldest first. */
export function pending(sessionId: string): QueuedInput[] {
  // `allEntities` returns newest-inserted first (rowid DESC), so the row's
  // distance from the end of that list is a stable insertion rank. Two messages
  // can share a millisecond, so `receivedAt` alone would not be a total order.
  const rows = allEntities<QueuedInput>("inputs");
  return rows
    .filter((q) => q.sessionId === sessionId && q.state === "received")
    .map((q, index) => ({ q, rank: rows.length - index }))
    .sort((a, b) => a.q.receivedAt - b.q.receivedAt || a.rank - b.rank)
    .map((entry) => entry.q);
}

/** Record that a queued message became an `input` event at `seq`. */
export function markAdmitted(id: string, seq: number): void {
  const q = getEntity<QueuedInput>("inputs", id);
  if (!q) return;
  q.state = "admitted";
  q.admittedSeq = seq;
  putEntity("inputs", q);
}

/** Drop a queued message the user no longer wants delivered. */
export function cancel(id: string): boolean {
  const q = getEntity<QueuedInput>("inputs", id);
  if (!q || q.state !== "received") return false;
  q.state = "canceled";
  putEntity("inputs", q);
  return true;
}

/** Remove a queued message outright (data controls / cleanup). */
export function drop(id: string): boolean {
  return removeEntity("inputs", id);
}

/**
 * Admit every pending message for a session, in arrival order.
 *
 * Each message becomes an `input` event keyed by its own id, so a crash between
 * the append and `markAdmitted` is harmless: the next call finds the event
 * already present and only fills in the state. Returns the admitted items.
 */
export function admitPending(sessionId: string): QueuedInput[] {
  const admitted: QueuedInput[] = [];
  for (const q of pending(sessionId)) {
    const ev = append<InputPayload>(
      sessionId,
      "input",
      { text: q.text, actor: "user", inputId: q.id },
      { idempotencyKey: q.id },
    );
    markAdmitted(q.id, ev.seq);
    admitted.push({ ...q, state: "admitted", admittedSeq: ev.seq });
  }
  return admitted;
}

/**
 * True when the session has at least one message waiting for admission. Called
 * once per step boundary, so it short-circuits instead of building the full
 * sorted list that `pending()` returns.
 */
export function hasPending(sessionId: string): boolean {
  return allEntities<QueuedInput>("inputs")
    .some((q) => q.sessionId === sessionId && q.state === "received");
}

/**
 * Admit every pending message in every session. Used once at boot: a message
 * that arrived while the process was down must become a durable `input` event
 * even if its task is never resumed.
 */
export function admitAllPending(): QueuedInput[] {
  const sessionIds = [...new Set(allEntities<QueuedInput>("inputs")
    .filter((q) => q.state === "received")
    .map((q) => q.sessionId))];
  return sessionIds.flatMap((sessionId) => admitPending(sessionId));
}

/** New stable id for a queued input. */
export function newInputId(): string {
  return newId("input");
}
