/**
 * Loam Video Studio command relay.
 *
 * Agent tools run in the Node server, but the "Loam Video"/"Loam Effects"
 * editors live in the browser (iframe postMessage bridges). This module is the
 * server half of the round trip:
 *
 *   enqueue()  -> publish one command on the task's event stream (SSE)
 *   panel      -> executes it with its bridge, POSTs /video-studio/result
 *   resolve()  -> settle the pending promise
 *
 * Guarantees:
 *  - one command at a time per task, in FIFO order;
 *  - a per-command timeout (default 120 s, configurable);
 *  - PANEL_NOT_OPEN when no client is attached to the task stream, so callers
 *    can auto-open the panel and retry;
 *  - results for unknown/already-settled command ids are ignored;
 *  - cancelTask() rejects every pending command when the task stops.
 */
import crypto from "node:crypto";
import { publishTaskEvent, subscriberCount } from "./streams.js";
import { BoundedMap } from "../memory/cache.js";
import { registerCacheStats } from "../memory/stats.js";

export type VideoStudioTarget = "film" | "effects";

export interface VideoStudioCommand {
  id: string;
  taskId: string;
  target: VideoStudioTarget;
  method: string;
  params: Record<string, unknown>;
}

export interface VideoStudioResult {
  id: string;
  taskId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type VideoStudioRelayErrorCode = "PANEL_NOT_OPEN" | "TIMEOUT" | "CANCELLED";

export class VideoStudioRelayError extends Error {
  readonly code: VideoStudioRelayErrorCode;

  constructor(code: VideoStudioRelayErrorCode, message: string) {
    super(message);
    this.name = "VideoStudioRelayError";
    this.code = code;
  }
}

export interface VideoStudioRelayOptions {
  /** Per-command timeout in milliseconds (default 120000). */
  timeoutMs?: number;
}

interface QueueItem {
  command: VideoStudioCommand;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface TaskQueue {
  items: QueueItem[];
  inFlight: boolean;
}

interface PendingCommand {
  taskId: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Read the timeout from the environment once, so tests can keep the default. */
function envTimeoutMs(): number {
  const raw = Number(process.env.LOAM_VIDEO_STUDIO_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export class VideoStudioRelay {
  private readonly timeoutMs: number;
  /** In-flight commands (J6: bounded). One entry per awaiting panel command; a
   *  panel that never answers holds its timer until the timeout, so the map is
   *  capped and the oldest entry's timer is cleared (its caller already failed). */
  private readonly pending = new BoundedMap<string, PendingCommand>(64, "video-studio-pending", (_id, entry) => {
    clearTimeout(entry.timer);
  });
  /** Per-task command queues (J6: bounded). `clearInFlight` and `cancelTask`
   *  drop a task once it has nothing left to do, so reaching the cap means an
   *  abandoned task queue. */
  private readonly tasks = new BoundedMap<string, TaskQueue>(128, "video-studio-tasks");

  constructor(options: VideoStudioRelayOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? envTimeoutMs();
    registerCacheStats("video-studio-pending", () => this.pending.stats());
    registerCacheStats("video-studio-tasks", () => this.tasks.stats());
  }

  /** True when at least one client is attached to the task's event stream. */
  isAttached(taskId: string): boolean {
    return subscriberCount(taskId) > 0;
  }

  /** Number of commands queued or running for a task. */
  pendingCount(taskId: string): number {
    const task = this.tasks.get(taskId);
    return task ? task.items.length + (task.inFlight ? 1 : 0) : 0;
  }

  /**
   * Enqueue a command for a task. Resolves with the panel's result, or rejects
   * with a {@link VideoStudioRelayError} (PANEL_NOT_OPEN / TIMEOUT / CANCELLED).
   */
  enqueue(taskId: string, target: VideoStudioTarget, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.isAttached(taskId)) {
      return Promise.reject(
        new VideoStudioRelayError("PANEL_NOT_OPEN", `no Loam Video panel is attached to task ${taskId}`),
      );
    }
    const command: VideoStudioCommand = {
      id: `vs_${crypto.randomBytes(8).toString("hex")}`,
      taskId,
      target,
      method,
      params,
    };
    return new Promise<unknown>((resolve, reject) => {
      let task = this.tasks.get(taskId);
      if (!task) {
        task = { items: [], inFlight: false };
        this.tasks.set(taskId, task);
      }
      task.items.push({ command, resolve, reject });
      void this.pump(taskId);
    });
  }

  /**
   * Settle a command from a panel result. Returns false when the id is unknown
   * or already settled (the result is ignored, never a crash).
   */
  resolve(result: VideoStudioResult): boolean {
    if (!result || typeof result.id !== "string") return false;
    const pending = this.pending.get(result.id);
    if (!pending) return false;
    this.pending.delete(result.id);
    clearTimeout(pending.timer);
    this.clearInFlight(pending.taskId);
    if (result.ok) pending.resolve(result.result);
    else pending.reject(new Error(result.error ?? `video studio command ${result.id} failed`));
    void this.pump(pending.taskId);
    return true;
  }

  /** Reject every pending command for a task (called when the task stops). */
  cancelTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      for (const item of task.items) {
        item.reject(new VideoStudioRelayError("CANCELLED", `task ${taskId} stopped before command ${item.command.id} ran`));
      }
      task.items = [];
      task.inFlight = false;
    }
    for (const [id, pending] of [...this.pending]) {
      if (pending.taskId !== taskId) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new VideoStudioRelayError("CANCELLED", `task ${taskId} stopped before command ${id} finished`));
    }
    this.tasks.delete(taskId);
  }

  /** Drop bookkeeping for a task with nothing left to do. */
  private clearInFlight(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.inFlight = false;
    if (task.items.length === 0) this.tasks.delete(taskId);
  }

  private pump(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.inFlight || task.items.length === 0) return;
    const item = task.items.shift()!;
    task.inFlight = true;
    const timer = setTimeout(() => this.timeoutCommand(item.command.id), this.timeoutMs);
    // The timer must never keep the process (or a test runner) alive on its own.
    timer.unref?.();
    this.pending.set(item.command.id, {
      taskId,
      resolve: item.resolve,
      reject: item.reject,
      timer,
    });
    publishTaskEvent(taskId, {
      type: "video_studio_command",
      id: item.command.id,
      target: item.command.target,
      method: item.command.method,
      params: item.command.params,
    });
  }

  private timeoutCommand(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.clearInFlight(pending.taskId);
    pending.reject(new VideoStudioRelayError("TIMEOUT", `video studio command ${id} timed out after ${this.timeoutMs}ms`));
    void this.pump(pending.taskId);
  }
}

/** Shared relay instance for the running server (one per process). */
export const videoStudioRelay = new VideoStudioRelay();
