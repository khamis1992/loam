/**
 * Loam Video Studio client half of the command relay.
 *
 * The Node server enqueues a command and publishes it on the task's event
 * stream (GET /api/tasks/:id/stream). This client opens that stream for the
 * task, executes every {@link VideoStudioCommand} with the editor bridge and
 * POSTs the result back to /api/tasks/:id/video-studio/result, which settles
 * the server-side promise. See src/server/workspaceRelay.ts.
 *
 * The transport itself is shared with the Craft apps through
 * `relayClientBase.ts` (cr-04); this class only keeps the fc-02 event type and
 * result route, so the Loam Video panel keeps working unchanged.
 */

import { getLoamAuthHeaders, getLoamBase } from '@/services/rpc';
import { RelayClientBase, type RelayExecutor, type RelayOpenRequest } from './relayClientBase';
import type { FilmcraftBridge } from './filmcraft';
import type { EffectcraftBridge, EffectcraftMethod } from './effectcraft';

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
  onOpenRequest?: (request: RelayOpenRequest) => void;
  /** Listen for open requests without executing commands or claiming a target. */
  observeOnly?: boolean;
}

/** The stream event type the fc-02 Video Studio relay publishes. */
const COMMAND_EVENT = 'video_studio_command';
/** The fc-02 result route, kept so existing panels keep working unchanged. */
const RESULT_PATH = '/video-studio/result';

/**
 * The Video Studio client: it subscribes to the legacy `video_studio_command`
 * frames and reports every result to `/api/tasks/:id/video-studio/result`.
 */
export class VideoStudioClient extends RelayClientBase<VideoStudioTarget> {
  constructor(options: VideoStudioClientOptions) {
    super(
      {
        taskId: options.taskId,
        executor: options.executor,
        commandEvents: [COMMAND_EVENT],
        resultPath: RESULT_PATH,
        apiBase: options.apiBase,
        headers: options.headers,
        fetchFn: options.fetchFn,
        autoReconnect: options.autoReconnect,
        reconnectDelayMs: options.reconnectDelayMs,
        onError: options.onError,
        onOpenRequest: options.onOpenRequest,
        targets: options.observeOnly ? [] : ['film', 'effects'],
        observeOnly: options.observeOnly,
      },
      getLoamBase,
    );
    this.defaultHeaders = getLoamAuthHeaders;
  }
}

/** The film engine imports each path as its own argument. An object leaves the timeline empty. */
/** Read a task media file into a browser File the video editor can import. */
export async function taskMediaFile(taskId: string, rel: string): Promise<File> {
  const path = rel.replace(/\\/g, '/');
  const url = `${getLoamBase()}/api/media?taskId=${encodeURIComponent(taskId)}&path=${encodeURIComponent(path)}`;
  const res = await fetch(url, { headers: getLoamAuthHeaders() });
  if (!res.ok) throw new Error(`could not read ${path}`);
  const blob = await res.blob();
  const name = path.split('/').pop() || 'media';
  return new File([blob], name, { type: blob.type || 'application/octet-stream' });
}

export function callStudioMethod(bridge: object, method: string, params: Record<string, unknown>): Promise<unknown> {
  const target = bridge as { call(method: string, ...args: unknown[]): Promise<unknown> };
  if (
    method === 'importFiles' &&
    Array.isArray(params.files) &&
    params.files.length > 0 &&
    params.files.every((file) => typeof File !== 'undefined' && file instanceof File)
  ) {
    return target.call(method, ...(params.files as File[]));
  }
  if (method === 'execute' && typeof params.command === 'string') {
    const inner = params.params && typeof params.params === 'object' ? params.params : {};
    return target.call(method, params.command, inner);
  }
  // The editor reads a path string. An object traps the engine the same way a
  // one-argument execute does.
  if (method === 'readFile') {
    const filePath = typeof params.path === 'string' ? params.path : typeof params.file === 'string' ? params.file : '';
    if (filePath) return target.call(method, filePath);
  }
  return target.call(method, params);
}

function callStudio(bridge: object, command: { method: string; params: Record<string, unknown> }): Promise<unknown> {
  return callStudioMethod(bridge, command.method, command.params);
}

/** Default executor: route film commands to the Loam Video bridge. */
export function createFilmcraftExecutor(bridge: FilmcraftBridge): VideoStudioExecutor {
  return async (command) => {
    if (command.target !== 'film') {
      throw new Error(`Loam Effects commands are not handled by the Loam Video bridge (target "${command.target}")`);
    }
    return callStudio(bridge, command);
  };
}

/** Neutral alias: the Video Studio client is the film/effects relay client. */
export const WorkspaceRelayClient = VideoStudioClient;
export type WorkspaceRelayExecutor = RelayExecutor<VideoStudioTarget>;

/**
 * Executor for the hidden "Loam Effects" backend.
 *
 * The effects engine answers the same `execute` / `inspect` / `readFile`
 * surface as the video editor, but it is a different iframe with its own
 * bridge, so a `target: "effects"` command must never be handed to the video
 * bridge (which would answer with the wrong engine's state).
 */
export function createEffectcraftExecutor(bridge: EffectcraftBridge): VideoStudioExecutor {
  return async (command) => {
    if (command.target !== 'effects') {
      throw new Error(`Loam Video commands are not handled by the Loam Effects bridge (target "${command.target}")`);
    }
    return bridge.call(command.method as EffectcraftMethod, command.params);
  };
}

/**
 * Route a command to whichever bridge owns it.
 *
 * The round trip alternates between the two engines, so the panel registers
 * exactly one executor that fans out by `target` and refuses anything else.
 */
export function createRoundTripExecutor(
  film: FilmcraftBridge,
  effects: EffectcraftBridge,
): VideoStudioExecutor {
  return async (command) => {
    if (command.target === 'film') {
      return callStudio(film, command);
    }
    if (command.target === 'effects') {
      return effects.call(command.method as EffectcraftMethod, command.params);
    }
    throw new Error(`unknown video studio target "${command.target}"`);
  };
}
