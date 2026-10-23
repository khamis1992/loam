/**
 * Neo N2: the Canvas live stream client.
 *
 * The server publishes a snapshot and then a `change` frame per graph update
 * (`GET /api/graph/:runId/stream`). Transport is fetch, not EventSource, because
 * the stream needs the install-token header, exactly like the Loam Video studio
 * relay. It reconnects when the stream closes while the task is still running.
 */
import { getLoamAuthHeaders, getLoamBase } from '@/services/rpc';

/** The initial graph snapshot the stream opens with. */
export interface CanvasStreamSnapshot {
  type: 'snapshot';
  runId: string;
  nodes: unknown[];
  edges: unknown[];
  stats: unknown;
}

/** A later change: the ids the agent touched and the run's new sequence. */
export interface CanvasStreamChange {
  type: 'change';
  runId: string;
  nodeIds: string[];
  seq: number;
}

export type CanvasStreamFrame = CanvasStreamSnapshot | CanvasStreamChange;

export interface CanvasStreamHandlers {
  onSnapshot?: (snapshot: CanvasStreamSnapshot) => void;
  onChange?: (change: CanvasStreamChange) => void;
  onError?: (error: unknown) => void;
}

export interface CanvasStreamOptions {
  runId: string;
  handlers?: CanvasStreamHandlers;
  /** Loam server base; defaults to getLoamBase() (http://127.0.0.1:<port>). */
  apiBase?: string;
  /** Auth headers; defaults to the install token header. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Fetch implementation (injectable for tests). */
  fetchFn?: typeof fetch;
  /** Reopen the stream when it closes (default true). */
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
  /** Test seam: replaces setTimeout so a test can drive the reconnect itself. */
  scheduler?: (fn: () => void, ms: number) => unknown;
  clearScheduled?: (handle: unknown) => void;
}

const SNAPSHOT_EVENT = 'snapshot';

export class CanvasStream {
  private readonly runId: string;
  private readonly handlers: CanvasStreamHandlers;
  private readonly apiBase: string;
  private readonly headers: (() => Record<string, string> | Promise<Record<string, string>>) | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly autoReconnect: boolean;
  private readonly reconnectDelayMs: number;
  private readonly scheduler: (fn: () => void, ms: number) => unknown;
  private readonly clearScheduled: (handle: unknown) => void;

  private running = false;
  private stopped = true;
  private abort: AbortController | null = null;
  private reconnectHandle: unknown = null;

  constructor(options: CanvasStreamOptions) {
    this.runId = options.runId;
    this.handlers = options.handlers ?? {};
    this.apiBase = options.apiBase ?? getLoamBase();
    this.headers = options.headers;
    this.fetchFn = options.fetchFn ?? fetch;
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.scheduler = options.scheduler ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearScheduled = options.clearScheduled ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
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
    if (this.reconnectHandle !== null) {
      this.clearScheduled(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    this.abort?.abort();
    this.abort = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.abort = new AbortController();
    let res: Response;
    try {
      res = await this.fetchFn(
        `${this.apiBase}/api/graph/${encodeURIComponent(this.runId)}/stream`,
        { headers: await this.resolveHeaders(), signal: this.abort.signal },
      );
    } catch (err) {
      this.running = false;
      if (this.stopped) return;
      this.handlers.onError?.(err);
      this.scheduleReconnect();
      return;
    }
    if (!res.ok || !res.body) {
      this.running = false;
      if (!this.stopped) {
        this.handlers.onError?.(new Error(`canvas stream failed with HTTP ${res.status}`));
        this.scheduleReconnect();
      }
      return;
    }
    await this.pump(res.body);
    this.running = false;
    if (!this.stopped) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.autoReconnect || this.stopped || this.reconnectHandle !== null) return;
    this.reconnectHandle = this.scheduler(() => {
      this.reconnectHandle = null;
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
      if (!this.stopped) this.handlers.onError?.(err);
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
      // A comment frame (keep-alive) carries no data.
      if (!payload || payload.startsWith(':')) continue;
      let frameData: CanvasStreamFrame;
      try {
        frameData = JSON.parse(payload) as CanvasStreamFrame;
      } catch {
        continue;
      }
      if (frameData.type === SNAPSHOT_EVENT) this.handlers.onSnapshot?.(frameData);
      else this.handlers.onChange?.(frameData);
    }
  }

  private async resolveHeaders(): Promise<Record<string, string>> {
    return this.headers ? this.headers() : getLoamAuthHeaders();
  }
}
