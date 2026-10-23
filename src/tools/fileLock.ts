/**
 * Per-path async mutex for the file-editing tools.
 *
 * Adapted from jcode (MIT) crates/jcode-app-core/src/tool/file_lock.rs.
 *
 * jcode serializes every read-modify-write cycle on a path behind a `tokio`
 * mutex so `batch`ed subcalls cannot both read the original and then race their
 * writes (which loses one edit and can leave a torn tail). Node is
 * single-threaded per tick, but a cycle that awaits — for example a slow
 * diagnostics run after the write — lets another cycle read the same file in
 * between, so the same guard is needed here.
 *
 * The map is process-wide (one daemon, many concurrent sessions). Each entry is
 * a FIFO promise chain with a refcount of outstanding acquisitions (held or
 * queued), so entries nobody holds or waits on are dropped and the map cannot
 * grow without bound. `lockAll` acquires paths in a stable sorted order, so
 * overlapping multi-file edits can never deadlock.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * One path's FIFO queue of acquisitions.
 *
 * `tail` is the last queued promise: acquiring chains off it, so waiters run in
 * arrival order. `refs` counts acquisitions still outstanding (held or queued);
 * releasing a guard removes it from the chain immediately, so `refs` stays exact
 * and the entry can be dropped once it reaches zero.
 */
interface MutexEntry {
  tail: Promise<void>;
  refs: number;
}

/** Plain Map is enough: every mutation happens in the same synchronous tick. */
const locks = new Map<string, MutexEntry>();

function entryFor(key: string): MutexEntry {
  const existing = locks.get(key);
  if (existing) return existing;
  const entry: MutexEntry = { tail: Promise.resolve(), refs: 0 };
  locks.set(key, entry);
  return entry;
}

/** Drop entries nobody holds or waits on, so the map cannot grow without bound. */
function prune(): void {
  for (const [key, entry] of locks) {
    if (entry.refs === 0) locks.delete(key);
  }
}

/** Lowercase on Windows, where the filesystem is case-insensitive. */
function normalizeKey(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/**
 * Normalize a path to a stable, collision-free lock key: realpath when the
 * file exists (so symlinks, `..` segments and spelling variants share one
 * lock), the resolved absolute path otherwise.
 */
export function lockKey(p: string): string {
  const resolved = path.resolve(p);
  try {
    return normalizeKey(fs.realpathSync(resolved));
  } catch {
    return normalizeKey(resolved);
  }
}

/**
 * Lock one path for a whole read-modify-write cycle. The returned guard must be
 * released exactly once, in a `finally`, or later cycles on that path would
 * wait forever. Acquisition order is FIFO.
 */
export async function lock(p: string): Promise<() => void> {
  const key = lockKey(p);
  const entry = entryFor(key);
  entry.refs++;
  let release!: () => void;
  const acquired = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = entry.tail;
  entry.tail = acquired;
  try {
    await previous;
  } catch {
    /* the previous waiter's release never rejects; kept for safety */
    release();
    entry.refs--;
    if (entry.refs <= 0) locks.delete(key);
    return () => {};
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    release();
    entry.refs--;
    if (entry.refs <= 0) locks.delete(key);
  };
}

/**
 * Lock several paths at once in a stable (sorted, de-duplicated) order, so
 * overlapping multi-file edits cannot deadlock each other. Guards come back in
 * the same sorted key order; every one must be released, and the order of
 * release does not matter.
 */
export async function lockAll(paths: Iterable<string>): Promise<Array<() => void>> {
  const keys = [...new Set([...paths].map(lockKey))].sort();
  const guards: Array<() => void> = [];
  try {
    for (const key of keys) {
      guards.push(await lock(key));
    }
  } catch (err) {
    for (const guard of guards) guard();
    throw err;
  }
  return guards;
}

/** Run `body` while holding the lock for `p`, always releasing it afterwards. */
export async function withLock<T>(p: string, body: () => Promise<T>): Promise<T> {
  const unlock = await lock(p);
  try {
    return await body();
  } finally {
    unlock();
  }
}

/** Run `body` while holding the locks for every path, always releasing them. */
export async function withLocks<T>(paths: Iterable<string>, body: () => Promise<T>): Promise<T> {
  const guards = await lockAll(paths);
  try {
    return await body();
  } finally {
    for (const guard of guards) guard();
  }
}

/** Number of live entries (test/diagnostic helper). */
export function lockMapSize(): number {
  prune();
  return locks.size;
}

/** Outstanding held + queued acquisitions for `p` (test/diagnostic helper). */
export function lockRefCount(p: string): number {
  const entry = locks.get(lockKey(p));
  return entry ? entry.refs : 0;
}

/** Whether `p` currently has a held or queued acquisition (diagnostic helper). */
export function isPathLocked(p: string): boolean {
  return lockRefCount(p) > 0;
}
