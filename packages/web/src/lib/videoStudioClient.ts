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
import { RelayClientBase, type RelayExecutor } from './relayClientBase';
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
      },
      getLoamBase,
    );
    this.defaultHeaders = getLoamAuthHeaders;
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

/** Neutral alias: the Video Studio client is the film/effects relay client. */
export const WorkspaceRelayClient = VideoStudioClient;
export type WorkspaceRelayExecutor = RelayExecutor<VideoStudioTarget>;
