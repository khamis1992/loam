/** Browser live-frame hub: the browser tool captures JPEG frames after every
 *  navigation/action; this hub keeps the latest frame per task and throttles
 *  emissions (default ~1 fps) to registered sinks (the protocol socket). */
import { BoundedMap } from "../memory/cache.js";
import { registerCacheStats } from "../memory/stats.js";
import type { CacheOwner } from "../memory/hibernation.js";

export interface BrowserFrame {
  url: string;
  title?: string;
  /** JPEG bytes without the data: prefix. */
  jpegBase64?: string;
  at: number;
}

export type BrowserFrameSink = (frame: BrowserFrame) => void;

let throttleMs = 1_000;

interface TaskFrameState {
  latest: BrowserFrame | null;
  lastEmitAt: number;
}

/**
 * Latest frame per task (J6). A frame holds a JPEG, so this map is the biggest
 * thing the hub retains; the oldest task's frame is dropped when a new task
 * would exceed the cap. Sinks stay separate because a dropped frame must not
 * detach a live subscriber.
 */
const frames = new BoundedMap<string, TaskFrameState>(64, "browser-frames");
/** Per-task subscriber sets (J6). A task that stops unsubscribing (a dropped
 *  renderer socket, a task that ended without a close) left a Set behind for
 *  every task id it ever had. Bounded LRU; eviction drops the set, which drops
 *  the subscribers with it (they are then free to re-register). */
const sinks = new BoundedMap<string, Set<BrowserFrameSink>>(128, "browser-frame-sinks");
registerCacheStats("browser-frame-sinks", () => sinks.stats());
/** Web session id -> Loam task id, set by the protocol socket so HTTP lookups
 *  (which only know the web session id) can find the task's latest frame. */
const aliases = new BoundedMap<string, string>(256, "browser-frame-aliases");
registerCacheStats("browser-frames", () => frames.stats());
registerCacheStats("browser-frame-aliases", () => aliases.stats());

export function setTaskFrameAlias(aliasKey: string, taskId: string): void {
  if (aliasKey && taskId) aliases.set(aliasKey, taskId);
}

export function setFrameThrottleMs(ms: number): void {
  throttleMs = Math.max(0, ms);
}

export function getFrameThrottleMs(): number {
  return throttleMs;
}

/** Register a sink for one task; returns an unsubscribe function. */
export function registerBrowserFrameSink(taskId: string, sink: BrowserFrameSink): () => void {
  let set = sinks.get(taskId);
  if (!set) {
    set = new Set();
    sinks.set(taskId, set);
  }
  set.add(sink);
  return () => {
    const current = sinks.get(taskId);
    if (current) {
      current.delete(sink);
      if (current.size === 0) sinks.delete(taskId);
    }
  };
}

/** Store a captured frame for `taskId`; emits throttled to the registered sinks.
 *  Returns true when the frame was pushed to at least one sink. */
export function publishBrowserFrame(
  taskId: string,
  frame: { url: string; title?: string; jpegBase64?: string },
): boolean {
  if (!taskId) return false;
  const at = Date.now();
  let state = frames.get(taskId);
  if (!state) {
    state = { latest: null, lastEmitAt: at };
    frames.set(taskId, state);
  }
  const next: BrowserFrame = { url: frame.url, title: frame.title, jpegBase64: frame.jpegBase64, at };
  state.latest = next;
  if (at - state.lastEmitAt < throttleMs) return false;
  state.lastEmitAt = at;
  const targets = sinks.get(taskId);
  if (!targets || targets.size === 0) return false;
  for (const sink of targets) {
    try {
      sink(next);
    } catch {
      /* a broken subscriber never blocks others */
    }
  }
  return true;
}

/** Latest captured frame, resolving web-session aliases (session uid -> task id). */
export function latestBrowserFrame(key: string): BrowserFrame | null {
  const taskId = aliases.get(key) ?? key;
  return frames.get(taskId)?.latest ?? null;
}

/** Resolve a web-session alias to the real task id (HTTP callers only know the
 *  web session id; sinks and frames are keyed by the Loam task id). */
export function resolveFrameKey(key: string): string {
  return aliases.get(key) ?? key;
}

/** Mirror of the event shape pushed over the socket; used for tests. */
export function buildBrowserFrameEvent(id: string, taskId: string, frame: BrowserFrame): {
  id: string;
  type: "browserFrame";
  timestamp: number;
  taskId: string;
  url: string;
  title?: string;
  jpegBase64?: string;
} {
  return {
    id,
    type: "browserFrame",
    timestamp: frame.at,
    taskId,
    url: frame.url,
    ...(frame.title ? { title: frame.title } : {}),
    ...(frame.jpegBase64 ? { jpegBase64: frame.jpegBase64 } : {}),
  };
}

export function resetBrowserFrames(): void {
  frames.clear();
  sinks.clear();
  aliases.clear();
  throttleMs = 1_000;
}

/** J7 hibernation: the latest captured frame is derived, reconstructible state
 *  (the browser re-captures it on the next navigation/action), so it is one of
 *  the derived caches a session may release when it goes idle. A frame holds a
 *  JPEG, so it is the largest derived object the hub retains for a task. */
export function browserFrameOwner(taskId: string): CacheOwner {
  return {
    name: "browser-frames",
    size: () => (frames.has(taskId) ? 1 : 0),
    bytes: () => frames.get(taskId)?.latest?.jpegBase64?.length ?? 0,
    clear: () => { frames.delete(taskId); },
  };
}
