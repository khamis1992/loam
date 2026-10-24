/**
 * Session-owned derived caches (J7), daemon side.
 *
 * Adapted from jcode (MIT) ref/SESSION_HIBERNATION.md — the same conservative
 * boundary: the daemon may discard a session's *derived* in-memory
 * representations (provider-message caches, reconstructible projections) while
 * its authoritative state (canonical messages, tool definitions, captured
 * instructions, undo state) stays resident and is rebuilt lazily.
 *
 * This module owns the per-task caches that the existing bounded-cache owners
 * do not own. It is a registry, not a policy: `hibernation.ts` decides *when*
 * a session is eligible to release these, and this module only answers
 * "what is there, and what does dropping it cost".
 *
 * Boundaries that keep it safe:
 * - Every cache here is keyed by task id and reconstructible. Nothing in this
 *   registry holds authoritative conversation content.
 * - `releaseTaskCaches` is scoped to one task, so hibernating one idle session
 *   can never drop a live session's derived state. A throwing owner is recorded
 *   as a partial release, never allowed to break the rest of the sweep.
 * - The registry never touches the network and never writes to disk.
 */
import { BoundedMap, LruCache, byteSizeOfString } from "./cache.js";
import { registerCacheStats, type CacheStats } from "./stats.js";

/** One named derived cache a session owns. */
export interface TaskCacheOwner {
  /** Logical name, reported by the hibernation counters. */
  name: string;
  /** Live entries right now (0 when unknown). */
  size(): number;
  /** Approximate retained bytes (0 when unknown). */
  bytes(): number;
  /** Drop the derived state. Must never throw: a partial release is fine. */
  clear(): void;
}

/** Entries kept per task. Bounded (J6) so a long-lived server cannot grow one
 *  owner per task forever; dropping an index is always safe because it is
 *  rebuilt from the authoritative log on the next read. */
const PER_TASK_CACHE_CAPACITY = 64;

/** Cached projection fold for one session's event log, keyed by task id.
 *
 *  The incremental fold mirrors the whole transcript for a session, so it is
 *  the largest derived object a chat view holds on the daemon side. Dropping it
 *  costs nothing authoritative: the next read re-folds from the append-only
 *  log. */
const taskProjections = new LruCache<{ lastSeq: number; state: unknown }>({
  capacity: PER_TASK_CACHE_CAPACITY,
  name: "session-task-projection",
  sizeOf: (value) => byteSizeOfString(JSON.stringify(value.state)),
});
registerCacheStats("session-task-projection", () => taskProjections.stats());

/** Per-task derived caches, keyed by task id -> owner name -> owner. */
const taskCaches = new BoundedMap<string, Map<string, TaskCacheOwner>>(PER_TASK_CACHE_CAPACITY, "session-task-caches");
registerCacheStats("session-task-caches", () => {
  // The enforced bound is the number of task slots, so report that (and the
  // approximate owner bytes retained across them) rather than a derived total
  // that no single map actually enforces.
  let bytes = 0;
  for (const [taskId, owners] of taskCaches.entries()) {
    bytes += byteSizeOfString(taskId);
    for (const owner of owners.values()) {
      try {
        bytes += owner.bytes();
      } catch {
        /* a throwing reader is reported, never fatal */
      }
    }
  }
  return { name: "session-task-caches", size: taskCaches.size, capacity: PER_TASK_CACHE_CAPACITY, bytes, maxBytes: 0 };
});

/** One derived projection a caller has folded for a session. */
export interface TaskProjection {
  taskId: string;
  /** Last event sequence folded into `state` (the incremental boundary). */
  lastSeq: number;
  /** The folded state itself (derived, reconstructible). */
  state: unknown;
}

/** Fold a session's projection, reusing a cached state keyed by the last seq.
 *  Passing `undefined` as `lastSeq` bypasses the cache (a one-shot fold). */
export function getTaskProjection(taskId: string, lastSeq: number, init: () => unknown, apply: (state: unknown, seq: number) => unknown): unknown {
  const cached = taskProjections.get(taskId);
  if (cached && cached.lastSeq === lastSeq) return cached.state;
  let state = cached && cached.lastSeq < lastSeq ? cached.state : init();
  for (let seq = cached ? cached.lastSeq + 1 : 0; seq <= lastSeq; seq++) {
    state = apply(state, seq);
  }
  taskProjections.set(taskId, { lastSeq, state });
  return state;
}

/** Register (or replace) one named derived cache owned by one task. */
export function registerTaskCache(taskId: string, owner: TaskCacheOwner): void {
  if (!taskId || !owner?.name) return;
  let owners = taskCaches.get(taskId);
  if (!owners) {
    owners = new Map();
    taskCaches.set(taskId, owners);
  }
  owners.set(owner.name, owner);
}

/** Drop every derived cache registered for one task. Returns the release
 *  accounting (entries and estimated bytes) for the hibernation counters. */
export function releaseTaskCaches(taskId: string): { entries: number; bytes: number; owners: string[] } {
  let entries = 0;
  let bytes = 0;
  const owners: string[] = [];
  const projection = taskProjections.take(taskId);
  if (projection) {
    entries += 1;
    bytes += byteSizeOfString(JSON.stringify(projection.state));
    owners.push("session-task-projection");
  }
  const registered = taskCaches.get(taskId);
  if (registered) {
    for (const [name, owner] of registered) {
      try {
        entries += owner.size();
        bytes += owner.bytes();
        owner.clear();
        owners.push(name);
      } catch {
        /* a throwing owner is a partial release, never fatal */
      }
    }
    taskCaches.delete(taskId);
  }
  return { entries, bytes, owners };
}

/** Live derived-cache accounting for one task (what a release would free). */
export function taskCacheBytes(taskId: string): { entries: number; bytes: number } {
  const projection = taskProjections.get(taskId);
  const registered = taskCaches.get(taskId);
  let entries = projection !== undefined ? 1 : 0;
  let bytes = projection !== undefined ? byteSizeOfString(JSON.stringify(projection.state)) : 0;
  if (registered) {
    for (const owner of registered.values()) {
      try {
        entries += owner.size();
        bytes += owner.bytes();
      } catch {
        /* a throwing reader is reported, never fatal */
      }
    }
  }
  return { entries, bytes };
}

/** Test/teardown helper: drop every session cache. */
export function resetSessionCaches(): void {
  taskProjections.clear();
  taskCaches.clear();
}
