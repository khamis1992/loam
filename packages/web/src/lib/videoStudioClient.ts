/**
 * Loam Video Studio client half of the command relay.
 *
 * The Node server enqueues a command and publishes it on the task's event
 * stream (GET /api/tasks/:id/stream). This client opens that stream for the
 * task, executes every {@link VideoStudioCommand} with the editor bridge and
 * POSTs the result back to /api/tasks/:id/video-studio/result, which settles
 * the server-side promise. See src/server/videoStudioRelay.ts.
 *
 * The transport uses fetch (not EventSource) because the stream requires the
 * install token header. It reconnects when the stream closes while running.
 */

import { getLoamAuthHeaders, getLoamBase } from '@/services/rpc';
import type { FilmcraftBridge, FilmcraftMethod } from './filmcraft';

export type VideoStudioTarget = 'film' | 'effects';

/** One command dispatched by the agent and executed by the attached panel. */
export interface VideoStudioCommand {
  id: string;
  taskId: string;
  target: VideoStudioTarget;
  method: string;
  params: Record<string, unknown>;
}

/** Executes one command with an editor bridge (film or effects). */
export type VideoStudioExecutor = (command: VideoStudioCommand) => Promise<unknown>;

export interface VideoStudioClientOptions {
  taskId: string;
  executor: VideoStudioExecutor;
  /** Loam server base; defaults to getLoamBase() (http://127.0.0.1:<port>). */
  apiBase?: string;
  /** Auth headers; defaults to the install token header. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Fetch implementation (injectable for tests). */
  fetchFn?: typeof fetch;
  /** Reopen the stream when it closes (default true). */
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
  onError?: (error: unknown) => void;
}

const COMMAND_EVENT = 'video_studio_command';
const RESULT_PATH = '/video-studio/result';

export class VideoStudioClient {
  private readonly taskId: string;
  private readonly executor: VideoStudioExecutor;
  private readonly apiBase: string;
  private readonly headers: (() => Record<string, string> | Promise<Record<string, string>>) | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly autoReconnect: boolean;
  private readonly reconnectDelayMs: number;
  private readonly onError: ((error: unknown) => void) | undefined;

  private running = false;
  private stopped = true;
  private abort: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: VideoStudioClientOptions) {
    this.taskId = options.taskId;
    this.executor = options.executor;
    this.apiBase = options.apiBase ?? getLoamBase();
    this.headers = options.headers;
    this.fetchFn = options.fetchFn ?? fetch;
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.onError = options.onError;
  }

  /** True while the stream is connected (or waiting to reconnect). */
  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.stopped = false;
    this.running = true;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.abort?.abort();
    this.abort = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.abort = new AbortController();
    let res: Response;
    try {
      res = await this.fetchFn(`${this.apiBase}/api/tasks/${encodeURIComponent(this.taskId)}/stream`, {
        headers: await this.resolveHeaders(),
        signal: this.abort.signal,
      });
    } catch (err) {
      this.running = false;
      if (this.stopped) return;
      this.onError?.(err);
      this.scheduleReconnect();
      return;
    }
    if (!res.ok || !res.body) {
      this.running = false;
      if (!this.stopped) {
        this.onError?.(new Error(`video studio stream failed with HTTP ${res.status}`));
        this.scheduleReconnect();
      }
      return;
    }
    await this.pump(res.body);
    this.running = false;
    if (!this.stopped) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.autoReconnect || this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start();
    }, this.reconnectDelayMs);
  }

  /** Read SSE frames until the stream ends. */
  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          this.handleFrame(frame);
        }
      }
      if (buffer.trim()) this.handleFrame(buffer);
    } catch (err) {
      if (!this.stopped) this.onError?.(err);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  private handleFrame(frame: string): void {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload.startsWith(':')) continue;
      let event: unknown;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      const record = event as { type?: unknown; id?: unknown; target?: unknown; method?: unknown; params?: unknown };
      if (record.type !== COMMAND_EVENT || typeof record.id !== 'string') continue;
      const params =
        record.params && typeof record.params === 'object' && !Array.isArray(record.params)
          ? (record.params as Record<string, unknown>)
          : {};
      void this.execute({
        id: record.id,
        taskId: this.taskId,
        target: record.target === 'effects' ? 'effects' : 'film',
        method: typeof record.method === 'string' ? record.method : '',
        params,
      });
    }
  }

  private async execute(command: VideoStudioCommand): Promise<void> {
    let ok = true;
    let result: unknown;
    let error: string | undefined;
    try {
      result = await this.executor(command);
    } catch (err) {
      ok = false;
      error = err instanceof Error ? err.message : String(err);
    }
    try {
      await this.fetchFn(`${this.apiBase}/api/tasks/${encodeURIComponent(command.taskId)}${RESULT_PATH}`, {
        method: 'POST',
        headers: { ...(await this.resolveHeaders()), 'content-type': 'application/json' },
        body: JSON.stringify({
          id: command.id,
          taskId: command.taskId,
          ok,
          ...(ok ? { result } : { error }),
        }),
      });
    } catch (err) {
      this.onError?.(err);
    }
  }

  private async resolveHeaders(): Promise<Record<string, string>> {
    return this.headers ? this.headers() : getLoamAuthHeaders();
  }
}

/** Default executor: route film commands to the Loam Video bridge. */
export function createFilmcraftExecutor(bridge: FilmcraftBridge): VideoStudioExecutor {
  return async (command) => {
    if (command.target !== 'film') {
      throw new Error(`Loam Effects commands are not handled by the Loam Video bridge (target "${command.target}")`);
    }
    return bridge.call(command.method as FilmcraftMethod, command.params);
  };
}
