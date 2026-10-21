/** Browser live-frame hub: the browser tool captures JPEG frames after every
 *  navigation/action; this hub keeps the latest frame per task and throttles
 *  emissions (default ~1 fps) to registered sinks (the protocol socket). */

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

const frames = new Map<string, TaskFrameState>();
const sinks = new Map<string, Set<BrowserFrameSink>>();

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

/** Latest captured frame for a task (kept even when throttling dropped the emit). */
export function latestBrowserFrame(taskId: string): BrowserFrame | null {
  return frames.get(taskId)?.latest ?? null;
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
  throttleMs = 1_000;
}
