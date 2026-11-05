/**
 * Loam workspace command relay (generalises the fc-02 Video Studio relay).
 *
 * Agent tools run in the Node server, but the editors live in the browser:
 * the "Loam Video"/"Loam Effects" editors (FilmCraft/EffectCraft iframes) and
 * the vendored Loam Craft apps (Loam Docs, Loam Sheets, Loam Slides, Loam
 * Photo, Loam Design, served from `loamcraft://`). This module is the server
 * half of the round trip for ALL of them:
 *
 *   enqueue()  -> publish one command on the task's event stream (SSE)
 *   panel      -> executes it with its editor bridge, POSTs the result back
 *   resolve()  -> settle the pending promise
 *
 * The five Craft apps are *not* covered by a single "craft" target: the same
 * command queue must stay independent per app, so a slow Loam Sheets save can
 * never hold up a Loam Docs edit. `isCraftTarget` therefore widens the queue key
 * per target.
 *
 * Guarantees:
 *  - one command at a time per task+target, in FIFO order;
 *  - a per-command timeout (default 30 s, configurable);
 *  - PANEL_NOT_OPEN when no client is attached to the task stream, published
 *    together with an `open_request` event so the client can auto-open the
 *    right panel (cr-03) and retry;
 *  - COMMAND_REJECTED when the panel executed the command and the editor
 *    refused it, so callers can report the editor's own error instead of
 *    treating the editor as unavailable;
 *  - results for unknown/already-settled command ids are ignored;
 *  - cancelTask() rejects every pending command when the task stops.
 *
 * The `videoStudioRelay` name and the `film` / `effects` targets are kept as
 * backward-compatible aliases of the neutral surface.
 */
import crypto from "node:crypto";
import type { AgentEvent } from "../agent/events.js";
import { log } from "../log.js";
import { BoundedMap } from "../memory/cache.js";
import { registerCacheStats } from "../memory/stats.js";
import { publishTaskEvent, subscriberCount } from "./streams.js";
import { announcedTargets } from "./relayAttach.js";

/**
 * The Loam Video Studio targets (FilmCraft / EffectCraft).
 *
 * Commands for these targets keep using the legacy `video_studio_command`
 * event type, so clients written against the fc-02 relay (the Loam Video panel)
 * keep working unchanged. Every other editor publishes `workspace_command`.
 */
export type VideoStudioTarget = "film" | "effects";

/** The vendored Loam Craft editors (cr-01/cr-02). */
export type CraftRelayTarget = "docs" | "sheets" | "slides" | "photo" | "design";

/** Every editor the relay can drive. */
export type WorkspaceRelayTarget = VideoStudioTarget | CraftRelayTarget;

/** True when the target is one of the five Craft apps. */
export function isCraftTarget(target: WorkspaceRelayTarget): target is CraftRelayTarget {
  return target === "docs" || target === "sheets" || target === "slides" || target === "photo" || target === "design";
}

export interface WorkspaceRelayCommand {
  id: string;
  taskId: string;
  target: WorkspaceRelayTarget;
  method: string;
  params: Record<string, unknown>;
}

/** Backward-compatible alias used by the Video Studio code. */
export type VideoStudioCommand = WorkspaceRelayCommand;

export interface WorkspaceRelayResult {
  id: string;
  taskId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Backward-compatible alias used by the Video Studio code. */
export type VideoStudioResult = WorkspaceRelayResult;

export type WorkspaceRelayErrorCode = "PANEL_NOT_OPEN" | "TIMEOUT" | "CANCELLED" | "COMMAND_REJECTED";

/** Backward-compatible alias used by the Video Studio code. */
export type VideoStudioRelayErrorCode = WorkspaceRelayErrorCode;

export class WorkspaceRelayError extends Error {
  readonly code: WorkspaceRelayErrorCode;

  constructor(code: WorkspaceRelayErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceRelayError";
    this.code = code;
  }
}

/** Backward-compatible alias used by the Video Studio code. */
export const VideoStudioRelayError = WorkspaceRelayError;

export interface WorkspaceRelayOptions {
  /** Per-command timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** How long to wait for a panel to attach after the open request (default 15000). */
  attachTimeoutMs?: number;
}

/** Backward-compatible alias used by the Video Studio code. */
export type VideoStudioRelayOptions = WorkspaceRelayOptions;
interface QueueItem {
  command: WorkspaceRelayCommand;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface TaskQueue {
  items: QueueItem[];
  inFlight: boolean;
}

interface PendingCommand {
  command: WorkspaceRelayCommand;
  taskId: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Human-readable editor name used in errors and open requests. */
function targetLabel(target: WorkspaceRelayTarget): string {
  if (target === "film") return "Loam Video";
  if (target === "effects") return "Loam Effects";
  return target === "docs" ? "Loam Docs" : target === "sheets" ? "Loam Sheets" : target === "slides" ? "Loam Slides" : target === "photo" ? "Loam Photo" : "Loam Design";
}

/** Queue key: one command at a time per task AND per target (Craft apps differ). */
function queueKey(taskId: string, target: WorkspaceRelayTarget): string {
  return `${taskId}::${target}`;
}

/** Every queue key starts with this task prefix. */
function queuePrefix(taskId: string): string {
  return `${taskId}::`;
}

/**
 * Read the per-command timeout from the environment once, so tests can keep the
 * default. Both the old (fc-02) and the new variable name are honoured.
 */
function envTimeoutMs(): number {
  const raw = Number(process.env.LOAM_WORKSPACE_RELAY_TIMEOUT_MS ?? process.env.LOAM_VIDEO_STUDIO_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function envAttachTimeoutMs(): number {
  const raw = Number(process.env.LOAM_RELAY_ATTACH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 15_000;
}

/** The stream event that carries one command. Video keeps its legacy event type. */
function commandEventType(target: WorkspaceRelayTarget): "video_studio_command" | "workspace_command" {
  return isCraftTarget(target) ? "workspace_command" : "video_studio_command";
}

export class WorkspaceRelay {
  private readonly timeoutMs: number;
  private readonly attachTimeoutMs: number;
  /** Bumped by cancelTask so an in-flight attach wait ends as CANCELLED. */
  private readonly cancelGeneration = new Map<string, number>();
  /** In-flight commands (J6: bounded). One entry per awaiting panel command; a
   *  panel that never answers holds its timer until the timeout, so the map is
   *  capped and the oldest entry's timer is cleared (its caller already failed).
   *  The counter names are the fc-02 ones: they are the documented caps in
   *  docs/MEMORY_BUDGET.md and `caps.test.ts` asserts them, and this relay is
   *  the same surface for every editor now. */
  private readonly pending = new BoundedMap<string, PendingCommand>(64, "video-studio-pending", (_id, entry) => {
    clearTimeout(entry.timer);
  });
  /** Per-task+target command queues (J6: bounded). `clearInFlight` and
   *  `cancelTask` drop a queue once it has nothing left to do, so reaching the
   *  cap means an abandoned editor queue. */
  private readonly tasks = new BoundedMap<string, TaskQueue>(128, "video-studio-tasks");
  /** Last open request per task, so a retrying shell can ask what to open.
   *  Bounded and uncounted: it is derived state that `cancelTask` always drops,
   *  and the parity test requires every registered counter to have a doc row. */
  private readonly openRequests = new BoundedMap<string, { target: WorkspaceRelayTarget; path: string | null }>(128);

  constructor(options: WorkspaceRelayOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? envTimeoutMs();
    this.attachTimeoutMs = options.attachTimeoutMs ?? envAttachTimeoutMs();
    registerCacheStats("video-studio-pending", () => this.pending.stats());
    registerCacheStats("video-studio-tasks", () => this.tasks.stats());
  }

  /**
   * True when a panel for this target is attached. An announced target list is
   * exact. A stream subscriber that did not announce targets still counts, so
   * existing panel clients keep working.
   */
  isAttached(taskId: string, target?: WorkspaceRelayTarget): boolean {
    const announced = announcedTargets(taskId);
    if (announced) return target ? announced.has(target) : announced.size > 0;
    return subscriberCount(taskId) > 0;
  }

  /**
   * The open request recorded for one task, or null. Reading it clears it, so a
   * shell that opened the panel does not see the same request twice.
   */
  takeOpenRequest(taskId: string, target: WorkspaceRelayTarget): { target: WorkspaceRelayTarget; path: string | null } | null {
    if (!isCraftTarget(target)) return null;
    const request = this.openRequests.get(taskId);
    if (!request || request.target !== target) return null;
    this.openRequests.delete(taskId);
    return request;
  }

  /**
   * The recorded open requests for one task (copies; the map is untouched).
   * The SSE stream replays these to a panel that subscribes after the request
   * was published, so the shell can still auto-open the editor.
   */
  openRequestsFor(taskId: string): Array<{ target: WorkspaceRelayTarget; path: string | null }> {
    const request = this.openRequests.get(taskId);
    return request ? [{ target: request.target, path: request.path }] : [];
  }

  /** Number of commands queued or running for one task+target queue. */
  pendingCount(taskId: string, target?: WorkspaceRelayTarget): number {
    if (!target) {
      let total = 0;
      for (const [key, task] of [...this.tasks]) {
        if (!key.startsWith(queuePrefix(taskId))) continue;
        total += task.items.length + (task.inFlight ? 1 : 0);
      }
      return total;
    }
    const task = this.tasks.get(queueKey(taskId, target));
    return task ? task.items.length + (task.inFlight ? 1 : 0) : 0;
  }

  /**
   * Enqueue a command for a task+target. Resolves with the panel's result, or
   * rejects with a {@link WorkspaceRelayError}: PANEL_NOT_OPEN (no panel
   * attached), TIMEOUT (panel never answered), CANCELLED (task stopped) or
   * COMMAND_REJECTED (the editor refused the command).
   *
   * When nothing is attached the relay also publishes a `workspace_open_request`
   * event on the task stream: the attached shell uses it to open the right
   * panel (cr-03) before retrying.
   */
  enqueue(
    taskId: string,
    target: WorkspaceRelayTarget,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.enqueueWhenAttached(taskId, target, method, params);
  }

  private async enqueueWhenAttached(
    taskId: string,
    target: WorkspaceRelayTarget,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.isAttached(taskId, target)) {
      const path = typeof params["path"] === "string" ? (params["path"] as string) : null;
      this.openRequests.set(taskId, { target, path });
      publishTaskEvent(taskId, { type: "workspace_open_request", target, path });
      const generation = this.cancelGeneration.get(taskId) ?? 0;
      const outcome = await this.waitForAttachment(taskId, target, generation);
      if (outcome === "cancelled") {
        throw new WorkspaceRelayError("CANCELLED", `task ${taskId} stopped before ${targetLabel(target)} attached`);
      }
      if (outcome !== "attached") {
        throw new WorkspaceRelayError("PANEL_NOT_OPEN", `no ${targetLabel(target)} panel is attached to task ${taskId}`);
      }
    }
    return this.enqueueNow(taskId, target, method, params);
  }

  private async waitForAttachment(taskId: string, target: WorkspaceRelayTarget, generation: number): Promise<"attached" | "timeout" | "cancelled"> {
    const deadline = Date.now() + this.attachTimeoutMs;
    let nextPublish = 0;
    for (;;) {
      if ((this.cancelGeneration.get(taskId) ?? 0) !== generation) return "cancelled";
      if (this.isAttached(taskId, target)) return "attached";
      if (Date.now() >= deadline) return (this.cancelGeneration.get(taskId) ?? 0) !== generation ? "cancelled" : "timeout";
      if (Date.now() >= nextPublish) {
        const request = this.openRequests.get(taskId);
        if (request) publishTaskEvent(taskId, { type: "workspace_open_request", target: request.target, path: request.path });
        nextPublish = Date.now() + 250;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private enqueueNow(
    taskId: string,
    target: WorkspaceRelayTarget,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const command: WorkspaceRelayCommand = {
      id: `ws_${crypto.randomBytes(8).toString("hex")}`,
      taskId,
      target,
      method,
      params,
    };
    return new Promise<unknown>((resolve, reject) => {
      const key = queueKey(taskId, target);
      let task = this.tasks.get(key);
      if (!task) {
        task = { items: [], inFlight: false };
        this.tasks.set(key, task);
      }
      task.items.push({ command, resolve, reject });
      void this.pump(key);
    });
  }

  /**
   * Settle a command from a panel result. Returns false when the id is unknown
   * or already settled (the result is ignored, never a crash).
   */
  resolve(result: WorkspaceRelayResult): boolean {
    if (!result || typeof result.id !== "string") return false;
    const pending = this.pending.get(result.id);
    if (!pending) return false;
    this.pending.delete(result.id);
    clearTimeout(pending.timer);
    this.clearInFlight(pending.taskId);
    if (result.ok) pending.resolve(result.result);
    else pending.reject(new WorkspaceRelayError("COMMAND_REJECTED", result.error ?? `workspace command ${result.id} failed`));
    void this.pumpQueueFor(pending.taskId);
    return true;
  }

  /** Reject every pending command for a task (called when the task stops). */
  cancelTask(taskId: string): void {
    this.cancelGeneration.set(taskId, (this.cancelGeneration.get(taskId) ?? 0) + 1);
    const prefix = queuePrefix(taskId);
    for (const [key, task] of [...this.tasks]) {
      if (!key.startsWith(prefix)) continue;
      for (const item of task.items) {
        item.reject(new WorkspaceRelayError("CANCELLED", `task ${taskId} stopped before ${targetLabel(item.command.target)} command ${item.command.id} ran`));
      }
      task.items = [];
      task.inFlight = false;
    }
    for (const [id, pending] of [...this.pending]) {
      if (pending.taskId !== taskId) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new WorkspaceRelayError("CANCELLED", `task ${taskId} stopped before ${targetLabel(pending.command.target)} command ${id} finished`));
    }
    for (const key of [...this.openRequests.keys()]) {
      if (key.startsWith(prefix)) this.openRequests.delete(key);
    }
    for (const key of [...this.tasks.keys()]) {
      if (key.startsWith(prefix)) this.tasks.delete(key);
    }
  }

  /** Re-pump the queue a just-settled command came from. */
  private pumpQueueFor(taskId: string): void {
    const prefix = queuePrefix(taskId);
    for (const key of [...this.tasks.keys()]) {
      if (key.startsWith(prefix)) void this.pump(key);
    }
  }

  /** Drop bookkeeping for a queue with nothing left to do. */
  private clearInFlight(taskId: string): void {
    const prefix = queuePrefix(taskId);
    for (const [key, task] of [...this.tasks]) {
      if (!key.startsWith(prefix)) continue;
      task.inFlight = false;
      if (task.items.length === 0) this.tasks.delete(key);
    }
  }

  private pump(key: string): void {
    const task = this.tasks.get(key);
    if (!task || task.inFlight || task.items.length === 0) return;
    const item = task.items.shift()!;
    task.inFlight = true;
    const timer = setTimeout(() => this.timeoutCommand(item.command.id), this.timeoutMs);
    // The timer must never keep the process (or a test runner) alive on its own.
    timer.unref?.();
    this.pending.set(item.command.id, {
      command: item.command,
      taskId: item.command.taskId,
      resolve: item.resolve,
      reject: item.reject,
      timer,
    });
    const eventType = commandEventType(item.command.target);
    log.info("relay_publish", {
      taskId: item.command.taskId,
      target: item.command.target,
      method: item.command.method,
      subscribers: subscriberCount(item.command.taskId),
    });
    publishTaskEvent(
      item.command.taskId,
      // The event type depends on the target, which TypeScript cannot narrow
      // through the helper; both branches are assignable to AgentEvent.
      {
        type: eventType,
        id: item.command.id,
        target: item.command.target,
        method: item.command.method,
        params: item.command.params,
      } as AgentEvent,
    );
  }

  /** Re-send commands still waiting for a panel. A subscriber that connects after the first publish would otherwise miss them. */
  replayPending(taskId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.command.taskId !== taskId) continue;
      publishTaskEvent(pending.command.taskId, {
        type: commandEventType(pending.command.target),
        id: pending.command.id,
        target: pending.command.target,
        method: pending.command.method,
        params: pending.command.params,
      } as AgentEvent);
    }
  }

  private timeoutCommand(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.clearInFlight(pending.taskId);
    pending.reject(new WorkspaceRelayError("TIMEOUT", `${targetLabel(pending.command.target)} did not answer "${pending.command.method}" (${pending.command.id}) within ${this.timeoutMs}ms`));
    this.pumpQueueFor(pending.taskId);
  }
}

/** Shared relay instance for the running server (one per process). */
export const workspaceRelay = new WorkspaceRelay();

/** Backward-compatible alias for the Video Studio code (fc-02 / fc-03). */
export const videoStudioRelay = workspaceRelay;

/**
 * Backward-compatible class alias. Tests that constructed `new
 * VideoStudioRelay()` keep working and get the same generalised behaviour.
 */
export class VideoStudioRelay extends WorkspaceRelay {}
