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

import {
  DEFAULT_CALL_TIMEOUT_MS,
  type BridgeId,
  type BridgePending,
  type BridgeReadyCallback,
  addMessageListener,
  armCallTimeout,
  BridgeQueue,
  bridgeTags,
  disposeBridge,
  parseBridgeMessage,
  rejectAllPending,
  settlePending,
  waitForApi,
} from './bridge-base';

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

/** Loose shape of project info returned by inspect/info. */
export interface FilmcraftProjectInfo {
  [key: string]: unknown;
}

/** Pending call contract, shared with bridge-base. */
interface PendingCall extends BridgePending {}

/** Ready callback type. */
type ReadyCallback = BridgeReadyCallback;

/**
 * Promise-based bridge to one editor iframe. Construct it once per mounted
 * iframe and call {@link dispose} on unmount.
 */
export class FilmcraftBridge {
  private readonly iframe: HTMLIFrameElement;
  private readonly pending = new Map<BridgeId, PendingCall>();
  private readonly readyCallbacks = new Set<ReadyCallback>();
  private nextId = 0;
  private readonly tags = bridgeTags('filmcraft');
  private readonly removeListener: () => void;
  /** Editor calls are serialised so the control channel stays deterministic. */
  private readonly queue = new BridgeQueue();

  constructor(iframe: HTMLIFrameElement) {
    this.iframe = iframe;
    this.tags = bridgeTags('filmcraft');
    this.removeListener = addMessageListener(iframe, (event) => this.handleMessage(event));
  }

  dispose(): void {
    disposeBridge(this.pending, this.readyCallbacks, this.removeListener, 'Loam Video bridge disposed');
  }

  /**
   * Resolves once the iframe's relay reports that `window.filmcraft` is
   * available (or that it timed out, in which case hasApi is false).
   * Rejects if the relay never answers within `timeoutMs`.
   */
  waitForApi(timeoutMs = 150_000): Promise<{ hasApi: boolean }> {
    return waitForApi(
      this.readyCallbacks,
      timeoutMs,
      (hasApi) => this.readyCallbacks.forEach((cb) => cb(hasApi)),
      (reason) => rejectAllPending(this.pending, reason),
    );
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
    return this.queue.run(() => this.sendCall<T>(method, ...args));
  }

  private sendCall<T>(method: FilmcraftMethod, ...args: unknown[]): Promise<T> {
    const id = `fc-${++this.nextId}`;
    const target = this.iframe.contentWindow;
    if (!target) return Promise.reject(new Error('Loam Video editor iframe is not mounted'));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer: null });
      armCallTimeout(this.pending, id, DEFAULT_CALL_TIMEOUT_MS, 'Loam Video editor call timed out');
      target.postMessage({ type: this.tags.call, id, method, args }, '*');
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

  // -- Internals --------------------------------------------------------

  private handleMessage(event: MessageEvent): void {
    const data = parseBridgeMessage(event.data);
    if (!data) return;
    if (data.type === this.tags.ready) {
      for (const callback of [...this.readyCallbacks]) callback(Boolean(data.hasApi));
      return;
    }
    if (data.type !== this.tags.result || typeof data.id !== 'string') return;
    if (data.ok) {
      settlePending(this.pending, data.id, { ok: true, value: data.result });
      return;
    }
    settlePending(this.pending, data.id, {
      ok: false,
      error: new Error(typeof data.error === 'string' ? data.error : 'Loam Video editor call failed'),
    });
  }
}