/**
 * Agent bridge for the vendored "Loam Effects" wasm engine (EffectCraft).
 *
 * EffectCraft is the hidden backend for transitions, effects and text/motion
 * animation. It is embedded in an iframe served from the privileged
 * loameffect:// scheme (registered in electron/main.cjs). That page runs an
 * injected relay (electron/effectcraft/bridge-relay.js) which exposes
 * `window.effectcraft` over postMessage. This module gives Loam agent tools
 * typed, promise-based functions to drive the engine: execute/commands/
 * inspect/renderFrame/screenshot/addFile/files/readFile/saveToBrowser/info/
 * flush.
 *
 * The engine can run in a hidden iframe for agent jobs or in the visible panel
 * for "Open in effects"; the bridge is agnostic to where the iframe lives.
 *
 * See docs/effectcraft-integration.md for the command mapping and message
 * protocol.
 */

/** URL the Effects panel loads the engine iframe from. */
export const EFFECTCRAFT_FRAME_URL = 'loameffect://app/index.html';

/** Methods exposed on window.effectcraft inside the engine iframe. */
export type EffectcraftMethod =
  | 'request'
  | 'execute'
  | 'commands'
  | 'inspect'
  | 'renderFrame'
  | 'screenshot'
  | 'addFile'
  | 'files'
  | 'readFile'
  | 'saveToBrowser'
  | 'info'
  | 'flush';

/** Loose shape of one entry returned by commands(); check ids at runtime. */
export interface EffectcraftCommandInfo {
  id: string;
  [key: string]: unknown;
}

export interface EffectcraftProjectInfo {
  [key: string]: unknown;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

type ReadyCallback = (hasApi: boolean) => void;

/**
 * Promise-based bridge to one engine iframe. Construct it once per mounted
 * iframe and call {@link dispose} on unmount.
 */
export class EffectcraftBridge {
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
      reject(new Error('Loam Effects bridge disposed'));
    }
    this.pending.clear();
    this.readyCallbacks.clear();
  }

  /**
   * Resolves once the iframe's relay reports that `window.effectcraft` is
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
        reject(new Error('Timed out waiting for the Loam Effects engine bridge'));
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
   * Call any method on the iframe's window.effectcraft (e.g. 'execute',
   * 'commands', 'inspect'). Prefer the typed helpers below in agent code.
   */
  async call<T = unknown>(method: EffectcraftMethod, ...args: unknown[]): Promise<T> {
    const id = `ec-${++this.nextId}`;
    const target = this.iframe.contentWindow;
    if (!target) throw new Error('Loam Effects engine iframe is not mounted');
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      target.postMessage({ type: 'effectcraft:call', id, method, args }, '*');
    });
  }

  // -- Engine primitives ----------------------------------------------------

  /** Run one engine command via window.effectcraft.execute({command, params}). */
  async execute<T = unknown>(command: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.call<T>('execute', { command, params });
  }

  /** Generic request passthrough (engine-defined signature). */
  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return params === undefined
      ? this.call<T>('request', method)
      : this.call<T>('request', method, params);
  }

  /** List the commands the engine supports. */
  async commands(): Promise<EffectcraftCommandInfo[]> {
    const result = await this.call<unknown>('commands');
    return Array.isArray(result) ? (result as EffectcraftCommandInfo[]) : [];
  }

  /** Inspect the current project/composition state. */
  async inspect<T = EffectcraftProjectInfo>(): Promise<T> {
    return this.call<T>('inspect');
  }

  /** Engine info (version, capabilities). */
  async info<T = EffectcraftProjectInfo>(): Promise<T> {
    return this.call<T>('info');
  }

  /** Render one frame of the current composition. */
  async renderFrame<T = unknown>(...args: unknown[]): Promise<T> {
    return this.call<T>('renderFrame', ...args);
  }

  /** Capture a screenshot of the current frame. */
  async screenshot<T = unknown>(): Promise<T> {
    return this.call<T>('screenshot');
  }

  /** Add a media file to the project (file already on disk). */
  async addFile<T = unknown>(...args: unknown[]): Promise<T> {
    return this.call<T>('addFile', ...args);
  }

  /** List files the engine currently knows about. */
  async files<T = unknown>(): Promise<T> {
    return this.call<T>('files');
  }

  /** Read a file previously written by the engine (e.g. renders). */
  async readFile<T = unknown>(...args: unknown[]): Promise<T> {
    return this.call<T>('readFile', ...args);
  }

  /** Save an engine output into the browser-side file store. */
  async saveToBrowser<T = unknown>(...args: unknown[]): Promise<T> {
    return this.call<T>('saveToBrowser', ...args);
  }

  /** Flush pending render-queue work. */
  async flush<T = unknown>(...args: unknown[]): Promise<T> {
    return this.call<T>('flush', ...args);
  }

  // -- Internals ------------------------------------------------------------

  private handleMessage(event: MessageEvent): void {
    if (event.source !== this.iframe.contentWindow) return;
    const data = event.data as
      | { type?: string; id?: string; ok?: boolean; result?: unknown; error?: string; hasApi?: boolean }
      | null
      | undefined;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    if (data.type === 'effectcraft:ready') {
      for (const callback of [...this.readyCallbacks]) callback(Boolean(data.hasApi));
      return;
    }
    if (data.type !== 'effectcraft:result' || typeof data.id !== 'string') return;
    const pending = this.pending.get(data.id);
    if (!pending) return;
    this.pending.delete(data.id);
    if (data.ok) pending.resolve(data.result);
    else pending.reject(new Error(data.error ?? 'Loam Effects engine call failed'));
  }
}
