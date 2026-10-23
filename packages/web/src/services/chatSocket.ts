/**
 * Chat socket service per BUILD_SPEC §6.10 / §7.2.
 *
 * Connects with socket.io-client over websockets only, sends a Bearer token in
 * the handshake auth, includes locale/timezone/client metadata in the query, and
 * re-joins the active session automatically after reconnect.
 */

import { io, type Socket } from 'socket.io-client';
import type {
  Attachment,
  ClientMessage,
  ServerMessage,
  TaskMode,
} from '@shared/socket';

const DEFAULT_SOCKET_BASE = '/';

export interface ChatSocketOptions {
  /** Async token getter; may return an empty string for unauthenticated dev. */
  getToken: () => Promise<string>;
  /** Called for every server frame. */
  onMessage: (m: ServerMessage) => void;
  /** Called when the handshake is rejected as unauthenticated. */
  onAuthFailure?: () => void;
  /** Called on transport/connection errors. */
  onError?: (message: string) => void;
  /** Optional socket.io base URL; defaults to '/'. */
  socketBase?: string;
  clientVersion?: string;
}

export class ChatSocket {
  private socket?: Socket;
  private rejoin?: () => void;
  /** BUILD_SPEC §6.4: the highest durable log `seq` seen per session, so a
   *  reconnect resumes by sequence instead of by a single cursor id. */
  private readonly lastSeqBySession = new Map<string, number>();
  /** Extra frame observers, called before `options.onMessage`. */
  private readonly messageListeners = new Set<(m: ServerMessage) => void>();
  private disposed = false;

  constructor(private readonly options: ChatSocketOptions) {}

  async connect() {
    if (this.disposed) return;
    const token = await this.options.getToken();
    this.socket = io(this.options.socketBase ?? DEFAULT_SOCKET_BASE, {
      transports: ['websocket'],
      withCredentials: false,
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 10_000,
      randomizationFactor: 0.5,
      auth: { token },
      query: {
        locale: typeof document !== 'undefined'
          ? document.documentElement.lang
          : 'en',
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        clientType: 'desktop',
        clientVersion: this.options.clientVersion ?? '0.0.0',
        'x-product-name': 'Loam',
      },
    });

    this.socket.on('connect', () => this.rejoin?.());
    this.socket.on('connect_error', (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('unauthenticated')) {
        this.options.onAuthFailure?.();
        return;
      }
      this.options.onError?.(msg);
    });
    this.socket.on('message', (m: ServerMessage) => this.options.onMessage(m));
    this.socket.on('message', (m: ServerMessage) => {
      for (const listener of this.messageListeners) listener(m);
    });

    // Wait for the initial websocket handshake so callers can emit immediately.
    return new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        this.socket?.off('connect_error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        this.socket?.off('connect', onConnect);
        reject(err);
      };
      this.socket?.once('connect', onConnect);
      this.socket?.once('connect_error', onError);
    });
  }

  disconnect() {
    this.disposed = true;
    this.socket?.disconnect();
    this.socket = undefined;
    this.rejoin = undefined;
    this.lastSeqBySession.clear();
    this.messageListeners.clear();
  }

  /** Observe every server frame (in addition to `options.onMessage`).
   *  Returns an unsubscribe function. */
  onMessage(listener: (m: ServerMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  private emit(m: ClientMessage) {
    this.socket?.emit('message', m);
  }

  private emitJoin(sessionId: string, lastMessageId?: string, lastSeq?: number) {
    this.emit({
      type: 'join_session',
      id: shortUid(),
      timestamp: Date.now(),
      sessionId,
      lastMessageId,
      ...(typeof lastSeq === 'number' ? { lastSeq } : {}),
      version: 2,
    });
  }

  /**
   * Join a session. If a dynamic last-seen id getter is supplied it is used
   * when re-joining after a reconnect, otherwise the static `lastMessageId`
   * is replayed. The highest `seq` observed on incoming frames is remembered
   * per session and sent as `lastSeq` on every join, so a reconnect resumes by
   * sequence.
   */
  join(
    sessionId: string,
    lastMessageId?: string,
    getLastId?: () => string | undefined,
    getLastSeq?: () => number | undefined,
  ) {
    this.rejoin = () => {
      // On reconnect only ask for events we have not already rendered.
      const id = getLastId?.() ?? lastMessageId;
      const seq = getLastSeq?.() ?? this.lastSeqBySession.get(sessionId);
      this.emitJoin(sessionId, id, seq);
    };
    this.emitJoin(sessionId, lastMessageId, getLastSeq?.() ?? this.lastSeqBySession.get(sessionId));
  }

  /** BUILD_SPEC §6.4: record the durable log sequence of a frame so the next
   *  reconnect resumes after it. No-op for frames without a `seq`. */
  noteSeq(sessionId: string, seq?: number) {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return;
    const current = this.lastSeqBySession.get(sessionId);
    if (current === undefined || seq > current) this.lastSeqBySession.set(sessionId, seq);
  }

  /** Stop sending the join payload after reconnects (e.g. on navigation away). */
  leave(sessionId: string) {
    this.lastSeqBySession.delete(sessionId);
    this.emit({
      type: 'leave_session',
      id: shortUid(),
      timestamp: Date.now(),
      sessionId,
    });
    this.rejoin = undefined;
  }

  /** Send a user text message, matching the wire field set observed live. */
  sendText(
    sessionId: string,
    content: string,
    taskMode: TaskMode,
    attachments: Attachment[] = [],
    extraExtData?: Record<string, unknown>,
  ) {
    this.emit({
      type: 'user_message',
      id: shortUid(),
      sessionId,
      timestamp: Date.now(),
      messageStatus: 'pending',
      messageType: 'text',
      taskMode,
      content: '',
      contents: [{ type: 'text', value: content }],
      attachments,
      extData: {
        capabilities: {
          enabledAddons: [],
          connectorAccounts: [],
          enabledConnectors: [],
        },
        ...extraExtData,
      },
    });
  }

  stop(sessionId: string) {
    this.emit({
      type: 'stop_session',
      id: shortUid(),
      timestamp: Date.now(),
      sessionId,
    });
  }

  resolveLocalExecutionApproval(
    sessionId: string,
    requestId: string,
    resolution: 'approve' | 'deny' | 'always',
  ) {
    this.emit({
      type: 'resolve_local_execution_approval',
      id: shortUid(),
      timestamp: Date.now(),
      sessionId,
      requestId,
      resolution,
    } as unknown as ClientMessage);
  }

  resolvePlanApproval(
    sessionId: string,
    requestId: string,
    decision: 'approve' | 'reject' | 'edit',
    plan?: { summary?: string; steps?: string[]; files_to_edit?: string[]; trivial?: boolean },
  ) {
    this.emit({
      type: 'resolve_plan_approval',
      id: shortUid(),
      timestamp: Date.now(),
      sessionId,
      requestId,
      decision,
      ...(plan ? { plan } : {}),
    } as unknown as ClientMessage);
  }

  /**
   * N9: answer or dismiss a pending ask-user clarification. `answer` carries the
   * free-text note, the per-question answers and any files already uploaded for
   * the request; `dismiss` closes the card without an answer.
   */
  resolveAskUser(
    sessionId: string,
    requestId: string,
    decision: 'answer' | 'dismiss',
    answer?: { text: string; answers: Record<string, string>; files: Array<{ path: string; name: string; bytes: number; contentType: string }> },
  ) {
    this.emit({
      type: 'resolve_ask_user',
      id: shortUid(),
      timestamp: Date.now(),
      sessionId,
      requestId,
      decision,
      ...(decision === 'answer' && answer ? { answer } : {}),
    } as unknown as ClientMessage);
  }

  submitWorkspaceDirectoryAccess(
    sessionId: string,
    requestActionId: string,
    accept: boolean,
  ) {
    this.emit({
      type: 'submit_workspace_directory_access',
      id: shortUid(),
      timestamp: Date.now(),
      sessionId,
      requestActionId,
      accept,
    } as unknown as ClientMessage);
  }

  isConnected() {
    return this.socket?.connected ?? false;
  }
}

/** 22-char base62 id, same length/alphabet as observed ids [O-RT]. */
export function shortUid(): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.getRandomValues(new Uint8Array(22));
  return Array.from(bytes, (x) => alphabet[x % 62]).join('');
}
