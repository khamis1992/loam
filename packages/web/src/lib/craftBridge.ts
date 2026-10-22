/**
 * Agent bridge for the vendored Loam Craft editors.
 *
 * Five editors ship as wasm web builds and are served from the privileged
 * `loamcraft://` scheme (see .cr-ref/CRAFT_PLAN.md and .cr-ref/craft/loam_bridge.rs):
 *   docs -> Loam Docs, sheets -> Loam Sheets, slides -> Loam Slides,
 *   photo -> Loam Photo, design -> Loam Design.
 * Each page runs an injected relay (electron/craft/bridge-relay.js) that exposes
 * the app's control channel over `craft:*` postMessage, exactly like the
 * desktop control server.
 *
 * This module is the typed, promise-based client for that protocol:
 *   - `waitReady()` waits for `craft:ready` and reports `{app, version}`
 *   - `call(method, params)` unwraps `{ok, result}` and throws a typed error on `ok:false`
 *   - `execute(command, params)` is `call('engine.execute', {command, params})`
 *   - `commands(search?)` lists the engine commands
 *   - `inspect()` reads the current document state
 *   - `open(name, bytes)` drops a file into the app
 *   - `onSave(cb)` receives every save/export (`craft:save`) with its bytes
 *   - `dispose()` detaches the listener and fails in-flight calls
 *
 * Only messages whose source is the embedded iframe are accepted, and calls are
 * serialised per bridge so the editor sees one request at a time.
 *
 * The shared mechanics (pending-call map, timeouts, source filtering, queue) live
 * in `bridge-base.ts`, which `FilmcraftBridge` also uses.
 */

import {
  DEFAULT_CALL_TIMEOUT_MS,
  type BridgeId,
  type BridgeMessage,
  type BridgePending,
  type BridgeReadyCallback,
  type BridgeTags,
  addMessageListener,
  armCallTimeout,
  BridgeQueue,
  bridgeTags,
  disposeBridge,
  parseBridgeMessage,
  rejectAllPending,
  settlePending,
} from './bridge-base';

/** The five Craft editors, keyed by the Loam product name. */
export type CraftApp = 'docs' | 'sheets' | 'slides' | 'photo' | 'design';

/** Internal (upstream) app id for one Loam editor. */
export type CraftInternalId = 'wordcraft' | 'gridcraft' | 'deckcraft' | 'photocraft' | 'designcraft';

/** Metadata for one editor: the upstream id and the user-facing name. */
export interface CraftAppInfo {
  /** Loam product key used by the panel and the registry. */
  app: CraftApp;
  /** Internal (upstream) id used by `loamcraft://` and the vendored build. */
  internalId: CraftInternalId;
  /** Exact user-facing name shown in the UI. */
  displayName: string;
}

/** App id map: Loam product key -> upstream id and display name. */
export const CRAFT_APPS: Record<CraftApp, CraftAppInfo> = {
  docs: { app: 'docs', internalId: 'wordcraft', displayName: 'Loam Docs' },
  sheets: { app: 'sheets', internalId: 'gridcraft', displayName: 'Loam Sheets' },
  slides: { app: 'slides', internalId: 'deckcraft', displayName: 'Loam Slides' },
  photo: { app: 'photo', internalId: 'photocraft', displayName: 'Loam Photo' },
  design: { app: 'design', internalId: 'designcraft', displayName: 'Loam Design' },
};

/** Resolve the Loam product key from an internal (upstream) id. */
export function craftAppFromInternalId(internalId: string): CraftApp | null {
  for (const info of Object.values(CRAFT_APPS)) {
    if (info.internalId === internalId) return info.app;
  }
  return null;
}

/** The `loamcraft://` URL the panel loads the editor iframe from. */
export function craftFrameUrl(app: CraftApp | CraftInternalId): string {
  const internalId = isInternalId(app) ? app : CRAFT_APPS[app].internalId;
  return `loamcraft://${internalId}/index.html?loam=1`;
}

function isInternalId(value: string): value is CraftInternalId {
  return Object.values(CRAFT_APPS).some((info) => info.internalId === value);
}

/** Methods the Craft control channel exposes (see .cr-ref/craft/protocols). */
export type CraftMethod =
  | 'engine.execute'
  | 'engine.commands'
  | 'document.inspect'
  | 'ui.inspect'
  | 'ui.screenshot'
  | 'ui.render'
  | 'ui.key'
  | 'ui.text'
  | 'ui.click'
  | 'ui.clickText'
  | 'ui.move'
  | 'ui.drag'
  | 'ui.press'
  | 'ui.release'
  | 'ui.wheel'
  | 'ui.focus'
  | 'ui.resize'
  | 'ui.parity';

/** Loose shape of one command returned by `commands()`. */
export interface CraftCommandInfo {
  id: string;
  label?: string;
  location?: string;
  shortcut?: string;
  params?: unknown;
  enabled?: boolean;
  [key: string]: unknown;
}

/** `{app, version}` reported by the app once its control channel is live. */
export interface CraftReady {
  app: string;
  version: string;
}

/** A save or export handed to the host instead of downloaded. */
export interface CraftSave {
  app: string;
  name: string;
  bytes: Uint8Array;
}

/** Typed error thrown when the app answers `ok:false`. */
export class CraftCallError extends Error {
  constructor(message: string, readonly method: string, readonly id: BridgeId | null) {
    super(message);
    this.name = 'CraftCallError';
  }
}

/** Typed error thrown when the app never becomes ready in time. */
export class CraftNotReadyError extends Error {
  constructor(message = 'The Loam Craft editor did not become ready in time') {
    super(message);
    this.name = 'CraftNotReadyError';
  }
}

/** Typed error thrown when a call does not answer within its timeout. */
export class CraftTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`Loam Craft editor did not answer "${method}" within ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'CraftTimeoutError';
  }
}

interface PendingCall extends BridgePending {}

type ReadyCallback = BridgeReadyCallback;

/**
 * Promise-based bridge to one Craft editor iframe. Construct it once per mounted
 * iframe and call {@link dispose} on unmount.
 */
export class CraftBridge {
  private readonly iframe: HTMLIFrameElement;
  private readonly pending = new Map<BridgeId, PendingCall>();
  private readonly readyCallbacks = new Set<ReadyCallback>();
  private readonly saveCallbacks = new Set<(save: CraftSave) => void>();
  private nextId = 0;
  private readonly tags: BridgeTags = bridgeTags('craft');
  private readonly removeListener: () => void;
  /** Calls are serialised so the editor's control channel stays deterministic. */
  private readonly queue = new BridgeQueue();
  private ready: CraftReady | null = null;
  constructor(iframe: HTMLIFrameElement) {
    this.iframe = iframe;
    this.removeListener = addMessageListener(iframe, (event) => this.handleMessage(event));
  }

  /** The `craft:*` message tags this bridge speaks. */
  get protocol(): BridgeTags {
    return this.tags;
  }

  dispose(): void {
    disposeBridge(this.pending, this.readyCallbacks, this.removeListener, 'Loam Craft bridge disposed');
    this.saveCallbacks.clear();
    this.ready = null;
  }

  /**
   * Resolves once the app reports `{type:'craft:ready', app, version}`.
   * Rejects with {@link CraftNotReadyError} when nothing answers within `timeoutMs`.
   */
  waitReady(timeoutMs = 30_000): Promise<CraftReady> {
    const already = this.ready;
    if (already) return Promise.resolve(already);
    return new Promise<CraftReady>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.readyCallbacks.delete(onReady);
        reject(new CraftNotReadyError());
      }, timeoutMs);
      const onReady: ReadyCallback = (hasApi) => {
        if (settled) return;
        if (!hasApi) {
          settled = true;
          clearTimeout(timer);
          this.readyCallbacks.delete(onReady);
          reject(new CraftNotReadyError());
          return;
        }
        const reported = this.ready;
        if (!reported) return;
        settled = true;
        clearTimeout(timer);
        this.readyCallbacks.delete(onReady);
        resolve(reported);
      };
      this.readyCallbacks.add(onReady);
    });
  }

  /** True once the app announced readiness. */
  isReady(): boolean {
    return this.ready !== null;
  }

  /** The `{app, version}` the app announced, or null before ready. */
  getReady(): CraftReady | null {
    return this.ready;
  }

  /** Subscribe to every `craft:save` (file.save / export / saveAs) the app emits. */
  onSave(callback: (save: CraftSave) => void): () => void {
    this.saveCallbacks.add(callback);
    return () => this.saveCallbacks.delete(callback);
  }

  /** Fire-and-forget: open a file as if it was dropped on the window. */
  open(name: string, bytes: Uint8Array): void {
    const target = this.iframe.contentWindow;
    if (!target) throw new Error('Loam Craft editor iframe is not mounted');
    target.postMessage({ type: this.tags.open, name, bytes }, '*');
  }

  /**
   * Call one control-channel method and unwrap `{ok, result}`.
   * Throws {@link CraftCallError} on `ok:false` and {@link CraftTimeoutError} on timeout.
   */
  call<T = unknown>(method: CraftMethod | string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<T> {
    return this.queue.run(() => this.sendCall<T>(method, params, timeoutMs));
  }

  private sendCall<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const id = `craft-${++this.nextId}`;
    const target = this.iframe.contentWindow;
    if (!target) return Promise.reject(new CraftNotReadyError('The Loam Craft editor iframe is not mounted'));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer: null });
      armCallTimeout(this.pending, id, timeoutMs, () => this.timeoutError(method, timeoutMs));
      target.postMessage({ type: this.tags.call, id, method, params }, '*');
    });
  }

  /** The typed timeout error for one method, so callers can catch it precisely. */
  private timeoutError(method: string, timeoutMs: number): CraftTimeoutError {
    return new CraftTimeoutError(method, timeoutMs);
  }

  // -- Engine primitives ----------------------------------------------------

  /** Run one engine command: `engine.execute {command, params}`. */
  execute<T = unknown>(command: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<T> {
    return this.call<T>('engine.execute', { command, params }, timeoutMs);
  }

  /** List engine commands, optionally filtered by a case-insensitive search. */
  async commands(search?: string): Promise<CraftCommandInfo[]> {
    const params = search ? { search } : {};
    const result = await this.call<unknown>('engine.commands', params);
    return Array.isArray(result) ? (result as CraftCommandInfo[]) : [];
  }

  /** Read the current document state (`document.inspect`). */
  inspect<T = unknown>(params: Record<string, unknown> = {}): Promise<T> {
    return this.call<T>('document.inspect', params);
  }

  /** Read the app's UI state (`ui.inspect`). */
  uiInspect<T = unknown>(): Promise<T> {
    return this.call<T>('ui.inspect');
  }

  /** Screenshot of the editor window, as base64 PNG (`ui.screenshot`). */
  screenshot<T = unknown>(): Promise<T> {
    return this.call<T>('ui.screenshot');
  }

  // -- Internals ------------------------------------------------------------

  private handleMessage(event: MessageEvent): void {
    const data = parseBridgeMessage(event.data);
    if (!data) return;
    if (data.type === this.tags.ready) {
      this.handleReady(data);
      return;
    }
    if (data.type === this.tags.save) {
      this.handleSave(data);
      return;
    }
    if (data.type !== this.tags.result || typeof data.id !== 'string') return;
    if (data.ok) {
      settlePending(this.pending, data.id, { ok: true, value: data.result });
      return;
    }
    const method = typeof data.method === 'string' ? data.method : 'unknown';
    settlePending(this.pending, data.id, {
      ok: false,
      error: new CraftCallError(
        typeof data.error === 'string' && data.error ? data.error : 'Loam Craft editor call failed',
        method,
        data.id,
      ),
    });
  }

  private handleReady(data: BridgeMessage): void {
    const app = typeof data.app === 'string' ? data.app : '';
    const version = typeof data.version === 'string' ? data.version : '';
    const hasApi = data.hasApi !== false && data.api !== false;
    if (!hasApi) {
      // The app started but exposes no control channel: nothing can be driven.
      const error = new CraftNotReadyError('The Loam Craft editor did not expose its control channel');
      for (const callback of [...this.readyCallbacks]) {
        try {
          callback(false);
        } catch {
          /* a listener failure must not break the bridge */
        }
      }
      rejectAllPending(this.pending, error);
      return;
    }
    this.ready = { app, version };
    for (const callback of [...this.readyCallbacks]) callback(true);
  }

  private handleSave(data: BridgeMessage): void {
    if (typeof data.name !== 'string' || !data.name) return;
    const bytes = toBytes(data.bytes);
    const save: CraftSave = {
      app: typeof data.app === 'string' ? data.app : '',
      name: data.name,
      bytes,
    };
    for (const callback of [...this.saveCallbacks]) {
      try {
        callback(save);
      } catch {
        /* a listener failure must not break the bridge */
      }
    }
  }
}

/** Normalise a postMessage byte payload (Uint8Array / array / base64 string). */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value.map((v) => Number(v) & 0xff));
  if (typeof value === 'string' && value) {
    try {
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch {
      /* not base64: treat as text */
    }
    return new TextEncoder().encode(value);
  }
  return new Uint8Array();
}
