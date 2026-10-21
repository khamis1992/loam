/**
 * Agent bridge for the vendored "Loam Video" wasm editor.
 *
 * The editor is embedded in an iframe served from the privileged loamfilm://
 * scheme (registered in electron/main.cjs). That page runs an injected relay
 * (electron/filmcraft/bridge-relay.js) which exposes `window.filmcraft` over
 * postMessage. This module gives Loam agent tools typed, promise-based
 * functions to drive the editor: newProject, importUrl, razorCut, export and
 * every other engine method (execute/commands/inspect/info/screenshot/...).
 *
 * See docs/filmcraft-integration.md for the command mapping and message
 * protocol.
 */

/** URL the Video panel loads the editor iframe from. */
export const FILMCRAFT_FRAME_URL = 'loamfilm://app/index.html';

/** Methods exposed on window.filmcraft inside the editor iframe. */
export type FilmcraftMethod =
  | 'execute'
  | 'commands'
  | 'inspect'
  | 'info'
  | 'screenshot'
  | 'importFiles'
  | 'importUrl'
  | 'openProject'
  | 'readFile'
  | 'files';

/** Loose shape of one entry returned by commands(); check ids at runtime. */
export interface FilmcraftCommandInfo {
  id: string;
  [key: string]: unknown;
}

export interface FilmcraftProjectInfo {
  [key: string]: unknown;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

type ReadyCallback = (hasApi: boolean) => void;

/**
 * Promise-based bridge to one editor iframe. Construct it once per mounted
 * iframe and call {@link dispose} on unmount.
 */
export class FilmcraftBridge {
  private readonly iframe: HTMLIFrameElement;
  private readonly pending = new Map<string, PendingCall>();
  private readonly readyCallbacks = new Set<ReadyCallback>();
  private nextId = 0;
  private readonly onMessage: (event: MessageEvent) => void;

  constructor(iframe: HTMLIFrameElement) {
    this.iframe = iframe;
    this.onMessage = (event) => this.handleMessage(event);
    window.addEventListener('message', this.onMessage);
  }

  dispose(): void {
    window.removeEventListener('message', this.onMessage);
    for (const { reject } of this.pending.values()) {
      reject(new Error('Loam Video bridge disposed'));
    }
    this.pending.clear();
    this.readyCallbacks.clear();
  }

  /**
   * Resolves once the iframe's relay reports that `window.filmcraft` is
   * available (or that it timed out, in which case hasApi is false).
   * Rejects if the relay never answers within `timeoutMs`.
   */
  waitForApi(timeoutMs = 150_000): Promise<{ hasApi: boolean }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        this.readyCallbacks.delete(onReady);
        reject(new Error('Timed out waiting for the Loam Video editor bridge'));
      }, timeoutMs);
      const onReady: ReadyCallback = (hasApi) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.readyCallbacks.delete(onReady);
        resolve({ hasApi });
      };
      this.readyCallbacks.add(onReady);
    });
  }

  /** Subscribe to bridge readiness announcements (fires at most once per boot). */
  onReady(callback: ReadyCallback): () => void {
    this.readyCallbacks.add(callback);
    return () => this.readyCallbacks.delete(callback);
  }

  /**
   * Call any method on the iframe's window.filmcraft (e.g. 'execute',
   * 'commands', 'inspect'). Prefer the typed helpers below in agent code.
   */
  async call<T = unknown>(method: FilmcraftMethod, ...args: unknown[]): Promise<T> {
    const id = `fc-${++this.nextId}`;
    const target = this.iframe.contentWindow;
    if (!target) throw new Error('Loam Video editor iframe is not mounted');
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      target.postMessage({ type: 'filmcraft:call', id, method, args }, '*');
    });
  }

  // -- Engine primitives ----------------------------------------------------

  /** Run one editor command via window.filmcraft.execute({command, params}). */
  async execute<T = unknown>(command: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.call<T>('execute', { command, params });
  }

  /** List the commands the engine supports (ids like file.newProject, export). */
  async commands(): Promise<FilmcraftCommandInfo[]> {
    const result = await this.call<unknown>('commands');
    return Array.isArray(result) ? (result as FilmcraftCommandInfo[]) : [];
  }

  /** Inspect the current project/timeline state. */
  async inspect<T = FilmcraftProjectInfo>(): Promise<T> {
    return this.call<T>('inspect');
  }

  /** Engine info (version, capabilities). */
  async info<T = FilmcraftProjectInfo>(): Promise<T> {
    return this.call<T>('info');
  }

  /** Capture a screenshot of the current frame. */
  async screenshot<T = unknown>(): Promise<T> {
    return this.call<T>('screenshot');
  }

  /** Import one media file into the project (file already on disk). */
  async importFiles<T = unknown>(...args: unknown[]): Promise<T> {
    return this.call<T>('importFiles', ...args);
  }

  /** Import media from a URL into the project. */
  async importUrl<T = unknown>(url: string, options?: Record<string, unknown>): Promise<T> {
    return this.call<T>('importUrl', ...(options === undefined ? [url] : [url, options]));
  }

  /** Open a previously saved project. */
  async openProject<T = unknown>(...args: unknown[]): Promise<T> {
    return this.call<T>('openProject', ...args);
  }

  /** Read a file previously written by the editor (e.g. exports). */
  async readFile<T = unknown>(...args: unknown[]): Promise<T> {
    return this.call<T>('readFile', ...args);
  }

  /** List files the editor currently knows about. */
  async files<T = unknown>(): Promise<T> {
    return this.call<T>('files');
  }

  // -- Mapped agent helpers (see docs/filmcraft-integration.md) --------------

  /** Create a new empty project (engine command `file.newProject`). */
  async newProject(params: Record<string, unknown> = {}): Promise<unknown> {
    return this.execute('file.newProject', params);
  }

  /** Create a new sequence (engine command `file.newSequence`). */
  async newSequence(params: Record<string, unknown> = {}): Promise<unknown> {
    return this.execute('file.newSequence', params);
  }

  /** Split the timeline at a playhead position (engine command `timeline.razor`). */
  async razorCut(params: Record<string, unknown>): Promise<unknown> {
    return this.execute('timeline.razor', params);
  }

  /** Add an edit/move to the sequence (engine command `sequence.addEdit`). */
  async addEdit(params: Record<string, unknown>): Promise<unknown> {
    return this.execute('sequence.addEdit', params);
  }

  /** Export the current project (engine command `export`). */
  async export(params: Record<string, unknown> = {}): Promise<unknown> {
    return this.execute('export', params);
  }

  // -- Internals ------------------------------------------------------------

  private handleMessage(event: MessageEvent): void {
    if (event.source !== this.iframe.contentWindow) return;
    const data = event.data as
      | { type?: string; id?: string; ok?: boolean; result?: unknown; error?: string; hasApi?: boolean }
      | null
      | undefined;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    if (data.type === 'filmcraft:ready') {
      for (const callback of [...this.readyCallbacks]) callback(Boolean(data.hasApi));
      return;
    }
    if (data.type !== 'filmcraft:result' || typeof data.id !== 'string') return;
    const pending = this.pending.get(data.id);
    if (!pending) return;
    this.pending.delete(data.id);
    if (data.ok) pending.resolve(data.result);
    else pending.reject(new Error(data.error ?? 'Loam Video editor call failed'));
  }
}