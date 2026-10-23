/**
 * Shared transport for the workspace command relays (cr-04).
 *
 * Both the fc-02 Video Studio relay and the Craft relay use the same round trip:
 *
 *   server enqueue()  -> SSE `data:` frame with one command on /api/tasks/:id/stream
 *   this client       -> executes it with the attached editor bridge
 *   server resolve()  <- POST the result back to /api/tasks/:id/<route>/result
 *
 * The transport uses fetch (not EventSource) because the stream requires the
 * install token header. It reconnects when the stream closes while running.
 *
 * Subclasses only decide which event types to act on and which result route to
 * post to (`VideoStudioRelayClient` keeps the fc-02 route, the Craft client
 * posts to the neutral one). See src/server/workspaceRelay.ts.
 */

/** Minimal shape of one command frame as published on the task stream. */
export interface RelayStreamCommand {
  id: string;
  taskId: string;
  target: string;
  method: string;
  params: Record<string, unknown>;
}

/**
 * What the client does with one decoded command. The target stays `string`
 * because the shared transport decodes the frame, and each relay validates its
 * own targets (`RelayTarget = string` by default).
 */
export type RelayTarget = string;

/** A decoded command narrowed to the targets one relay actually serves. */
export type RelayCommand<TTarget extends string = RelayTarget> = RelayStreamCommand & { target: TTarget };

export type RelayExecutor<TTarget extends string = RelayTarget> = (command: RelayCommand<TTarget>) => Promise<unknown>;

/** A live `workspace_open_request` from the server (no panel attached). */
export interface RelayOpenRequest {
  type: 'workspace_open_request';
  target: string;
  path?: string | null;
}

export interface RelayClientBaseOptions<TTarget extends string = RelayTarget> {
  taskId: string;
  /** Executes one decoded command; the target must be one this relay serves. */
  executor: RelayExecutor<TTarget>;
  /** Event types this client executes (its own targets). */
  commandEvents: string[];
  /** URL path the results are posted to. */
  resultPath: string;
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
  /** Called for every open request the stream carries (cr-03 auto-open). */
  onOpenRequest?: (request: RelayOpenRequest) => void;
}

/**
 * The stream half of one relay: subscribe, decode, dispatch, report. Kept free
 * of editor-specific knowledge so film, effects and the five Craft apps share it.
 */
export class RelayClientBase<TTarget extends string = RelayTarget> {
  protected readonly taskId: string;
  protected readonly executor: RelayExecutor<TTarget>;
  private readonly commandEvents: string[];
  private readonly resultPath: string;
  private readonly apiBase: string;
  private readonly headers: (() => Record<string, string> | Promise<Record<string, string>>) | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly autoReconnect: boolean;
  private readonly reconnectDelayMs: number;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly onOpenRequest: ((request: RelayOpenRequest) => void) | undefined;

  private running = false;
  private stopped = true;
  private abort: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RelayClientBaseOptions<TTarget>, defaultApiBase: () => string) {
    this.taskId = options.taskId;
    // The frame target is decoded as a plain string; the subclass validates it.
    this.executor = options.executor as RelayExecutor<TTarget>;
    this.commandEvents = options.commandEvents;
    this.resultPath = options.resultPath;
    this.apiBase = options.apiBase ?? defaultApiBase();
    this.headers = options.headers;
    this.fetchFn = options.fetchFn ?? fetch;
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.onError = options.onError;
    this.onOpenRequest = options.onOpenRequest;
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
        this.onError?.(new Error(`relay stream failed with HTTP ${res.status}`));
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
      const record = event as { type?: unknown; id?: unknown; target?: unknown; method?: unknown; params?: unknown; path?: unknown };
      if (record.type === 'workspace_open_request') {
        if (typeof record.target !== 'string') continue;
        this.onOpenRequest?.({ type: 'workspace_open_request', target: record.target, path: typeof record.path === 'string' ? record.path : null });
        continue;
      }
      if (!this.commandEvents.includes(String(record.type)) || typeof record.id !== 'string') continue;
      const params =
        record.params && typeof record.params === 'object' && !Array.isArray(record.params)
          ? (record.params as Record<string, unknown>)
          : {};
      void this.execute({
        id: record.id,
        taskId: this.taskId,
        target: (typeof record.target === 'string' ? record.target : '') as TTarget,
        method: typeof record.method === 'string' ? record.method : '',
        params,
      });
    }
  }

  private async execute(command: RelayCommand<TTarget>): Promise<void> {
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
      await this.fetchFn(`${this.apiBase}/api/tasks/${encodeURIComponent(command.taskId)}${this.resultPath}`, {
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
    return this.headers ? this.headers() : this.defaultHeaders();
  }

  /** The install token headers; injected by the subclass constructor. */
  protected defaultHeaders: () => Record<string, string> | Promise<Record<string, string>> = () => ({});
}
