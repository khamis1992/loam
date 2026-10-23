import type { AgentEvent } from "../agent/events.js";
import { BoundedMap } from "../memory/cache.js";
import { registerCacheStats } from "../memory/stats.js";

type Listener = (event: AgentEvent) => void;

/**
 * In-memory pub/sub so the UI can watch a running task live (in addition to
 * persisted steps).
 *
 * Bounded (J6): `subscribeTask`'s unsubscribe removes its entry, so reaching the
 * cap means abandoned listeners (a client that vanished without closing its
 * stream). The cap therefore only ever drops streams nobody is reading.
 */
const subs = new BoundedMap<string, Set<Listener>>(512, "task-event-subs");
registerCacheStats("task-event-subs", () => subs.stats());

export function publishTaskEvent(taskId: string, event: AgentEvent): void {
  const set = subs.get(taskId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch {
      /* ignore */
    }
  }
}

export function subscribeTask(taskId: string, listener: Listener): () => void {
  let set = subs.get(taskId);
  if (!set) {
    set = new Set();
    subs.set(taskId, set);
  }
  set.add(listener);
  return () => {
    const s = subs.get(taskId);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) subs.delete(taskId);
  };
}

export function runningTaskCount(): number {
  return subs.size;
}

/** Live subscriber count for one task's event stream (0 means no panel attached). */
export function subscriberCount(taskId: string): number {
  return subs.get(taskId)?.size ?? 0;
}
