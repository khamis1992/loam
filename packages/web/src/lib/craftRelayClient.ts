/**
 * Craft relay client half of the workspace command relay (cr-04).
 *
 * The server-side `workspaceRelay` (src/server/workspaceRelay.ts) enqueues a
 * command for a Craft app target (`docs` | `sheets` | `slides` | `photo` |
 * `design`), publishes it as a `workspace_command` frame on the task's event
 * stream, and settles a promise when this client POSTs the result back to
 * `/api/tasks/:id/workspace/result`. The transport is the shared
 * {@link RelayClientBase}; this module owns the Craft specifics:
 *
 *   - `craft.open`   : fetch a task file and drop it into the editor iframe
 *                       (`{type:'craft:open', name, bytes}`), so the app behaves
 *                       exactly as if the file had been dropped on its window;
 *   - `craft.waitSave` : run `file.save` (or another save/export command),
 *                       wait for the `craft:save` upload to finish, and resolve
 *                       with the stored task-file path the agent can then read.
 *
 * Every other method goes straight to the bridge as
 * `engine.execute {command, params}` / `call(method, params)`, so the agent
 * tool can reach the whole control protocol (document.inspect, sheet.read, ...).
 *
 * When the server has no panel attached it publishes a `workspace_open_request`
 * on the stream; cr-03 auto-opens the right panel from it, so the client only
 * reports it through {@link CraftRelayClientOptions.onOpenRequest}.
 */

import { getLoamAuthHeaders, getLoamBase } from '@/services/rpc';
import type { CraftApp, CraftSave } from './craftBridge';
import { fetchTaskFileBytes, getCraftBridge, uploadSave } from '@/components/workspace/craft/CraftPanel';
import { RelayClientBase, type RelayExecutor, type RelayOpenRequest } from './relayClientBase';

/** The five Craft editor targets of the shared workspace relay. */
export type CraftRelayTarget = CraftApp;

/** Every target this client can serve. */
export type CraftWorkspaceTarget = CraftRelayTarget;

/** One Craft command as published on the task stream. */
export interface CraftRelayCommand {
  id: string;
  taskId: string;
  target: CraftWorkspaceTarget;
  method: string;
  params: Record<string, unknown>;
}

/** Executes one Craft command against the mounted editor bridge. */
export type CraftRelayExecutor = (command: CraftRelayCommand) => Promise<unknown>;

/** The bridge surface the Craft executor needs (a subset of `CraftBridge`). */
export interface CraftBridgeLike {
  open(name: string, bytes: Uint8Array): void;
  onSave(callback: (save: CraftSave) => void): () => void;
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

/** Everything a caller can override (tests inject fakes for all of them). */
export interface CraftRelayClientOptions {
  taskId: string;
  executor?: CraftRelayExecutor;
  /** Resolve the bridge for one task + app (default `getCraftBridge`). */
  getBridge?: (taskId: string, app: CraftApp) => CraftBridgeLike | null;
  /** Read one task file's bytes (default `fetchTaskFileBytes`). */
  fetchBytes?: (taskId: string, path: string) => Promise<Uint8Array>;
  /** Store saved bytes in the task's files (default `uploadSave`). */
  uploadBytes?: (taskId: string, name: string, bytes: Uint8Array) => Promise<void>;
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
  /** Called for every `workspace_open_request` (cr-03 auto-open hook). */
  onOpenRequest?: (request: RelayOpenRequest) => void;
}

/** Stream event types this client reacts to. */
const COMMAND_EVENT = 'workspace_command';
/** The neutral result route shared by every non-video target. */
const RESULT_PATH = '/workspace/result';
/** The Craft targets this client serves (a guard against a mistyped target). */
const CRAFT_RELAY_TARGETS: readonly CraftApp[] = ['docs', 'sheets', 'slides', 'photo', 'design'];

/** Parameters accepted by the `craft.open` pseudo-method. */
export interface CraftOpenParams {
  /** Path of the task file to open, relative to the task workspace. */
  path?: string;
  /** Open the file under this name instead of the path's basename. */
  name?: string;
}

/** Parameters accepted by the `craft.waitSave` pseudo-method. */
export interface CraftWaitSaveParams {
  /** Engine command that produces the save (default `file.save`). */
  command?: string;
  /** Params forwarded to that command. */
  params?: Record<string, unknown>;
  /** How long to wait for the `craft:save` (default 60 s). */
  timeoutMs?: number;
}

/** Default wait for a `craft:save` after the save command returned. */
export const DEFAULT_WAIT_SAVE_TIMEOUT_MS = 60_000;

/**
 * The Craft half of the workspace relay: one mounted client per task drives
 * every attached Craft panel for that task.
 */
export class CraftRelayClient extends RelayClientBase<CraftRelayTarget> {
  constructor(options: CraftRelayClientOptions) {
    super(
      {
        taskId: options.taskId,
        executor: options.executor ?? craftRelayExecutor(options),
        commandEvents: [COMMAND_EVENT],
        resultPath: RESULT_PATH,
        apiBase: options.apiBase,
        headers: options.headers,
        fetchFn: options.fetchFn,
        autoReconnect: options.autoReconnect,
        reconnectDelayMs: options.reconnectDelayMs,
        onError: options.onError,
        onOpenRequest: options.onOpenRequest,
      },
      getLoamBase,
    );
    this.defaultHeaders = getLoamAuthHeaders;
  }
}

/**
 * Default Craft executor: route every target to its mounted bridge and turn the
 * two pseudo-methods (`craft.open`, `craft.waitSave`) into bridge calls.
 */
export function craftRelayExecutor(options: CraftRelayClientOptions): CraftRelayExecutor {
  const getBridge = options.getBridge ?? ((taskId: string, app: CraftApp) => getCraftBridge(taskId, app));
  const fetchBytes = options.fetchBytes ?? fetchTaskFileBytes;
  const uploadBytes = options.uploadBytes ?? uploadSave;

  return async (command) => {
    const target = CRAFT_RELAY_TARGETS.includes(command.target as CraftApp) ? (command.target as CraftApp) : null;
    if (!target) {
      throw new Error(`unknown Loam Craft target "${command.target}" for task ${command.taskId}`);
    }
    const bridge = getBridge(command.taskId, target);
    if (!bridge) {
      throw new Error(`no Loam ${String(command.target)} panel is mounted for task ${command.taskId}`);
    }
    if (command.method === 'craft.open') {
      await craftOpen(bridge, command, fetchBytes);
      return { opened: command.params.path ?? command.params.name ?? null };
    }
    if (command.method === 'craft.waitSave') {
      const path = await craftWaitSave(bridge, command, uploadBytes);
      return { path };
    }
    return bridge.call(command.method, command.params);
  };
}

/** `craft.open`: fetch the task file and drop it into the editor iframe. */
async function craftOpen(
  bridge: CraftBridgeLike,
  command: CraftRelayCommand,
  fetchBytes: (taskId: string, path: string) => Promise<Uint8Array>,
): Promise<void> {
  const params = command.params as CraftOpenParams;
  const path = typeof params.path === 'string' ? params.path : '';
  if (!path) throw new Error('craft.open needs a "path" param (a task file path)');
  const bytes = await fetchBytes(command.taskId, path);
  const name = typeof params.name === 'string' && params.name ? params.name : path.split(/[\\/]/).pop() ?? path;
  bridge.open(name, bytes);
}

/** `craft.waitSave`: run the save command, then wait for its `craft:save` upload. */
async function craftWaitSave(
  bridge: CraftBridgeLike,
  command: CraftRelayCommand,
  uploadBytes: (taskId: string, name: string, bytes: Uint8Array) => Promise<void>,
): Promise<string> {
  const params = command.params as CraftWaitSaveParams;
  const saveCommand = typeof params.command === 'string' && params.command ? params.command : 'file.save';
  const saveParams = params.params && typeof params.params === 'object' && !Array.isArray(params.params) ? params.params : {};
  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_WAIT_SAVE_TIMEOUT_MS;

  const stored = waitForSave(bridge, command.taskId, uploadBytes, timeoutMs);
  try {
    await bridge.call('engine.execute', { command: saveCommand, params: saveParams });
  } catch (err) {
    stored.cancel();
    throw err;
  }
  return stored.promise;
}

/** The in-flight `craft:save` upload of one `craft.waitSave`. */
interface PendingSave {
  promise: Promise<string>;
  cancel: () => void;
}

function waitForSave(
  bridge: CraftBridgeLike,
  taskId: string,
  uploadBytes: (taskId: string, name: string, bytes: Uint8Array) => Promise<void>,
  timeoutMs: number,
): PendingSave {
  let unsubscribe: (() => void) | null = null;
  let settle!: (value: string) => void;
  let fail!: (error: Error) => void;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const promise = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
    unsubscribe = bridge.onSave((save) => {
      // The app hands the bytes to the host instead of downloading them: store
      // them in the task's files, exactly like the panel's own Save button.
      void uploadBytes(taskId, save.name, save.bytes)
        .then(() => {
          finish();
          settle(save.name);
        })
        .catch((err: unknown) => {
          finish();
          fail(err instanceof Error ? err : new Error(String(err)));
        });
    });
    // The timer must never keep a test runner alive on its own.
    timer = setTimeout(() => {
      finish();
      fail(new Error(`the Loam Craft editor did not hand over its save within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    timer.unref?.();
  });

  function finish(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    unsubscribe?.();
    unsubscribe = null;
  }

  return {
    promise,
    cancel: () => {
      finish();
      fail(new Error('craft.waitSave was cancelled'));
    },
  };
}

/** Neutral alias for the shared workspace relay client. */
export const WorkspaceRelayClient = CraftRelayClient;
export type WorkspaceRelayExecutor = RelayExecutor<CraftRelayTarget>;
