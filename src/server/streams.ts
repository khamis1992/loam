import type { AgentEvent } from "../agent/events.js";

type Listener = (event: AgentEvent) => void;

/** In-memory pub/sub so the UI can watch a running task live (in addition to persisted steps). */
const subs = new Map<string, Set<Listener>>();

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
