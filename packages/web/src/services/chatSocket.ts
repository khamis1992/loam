/**
 * Chat socket service per BUILD_SPEC §6.10 / §7.2.
 *
 * Connects with socket.io-client over websockets only, sends a Bearer token in
 * the handshake auth, includes locale/timezone/client metadata in the query, and
 * re-joins the active session automatically after reconnect.
 */

import { io, type Socket } from 'socket.io-client';
import { env } from '@agent-studio/shared';
import type {
  Attachment,
  ClientMessage,
  ServerMessage,
  TaskMode,
} from '@agent-studio/shared';

export interface ChatSocketOptions {
  /** Async token getter; may return an empty string for unauthenticated dev. */
  getToken: () => Promise<string>;
  /** Called for every server frame. */
  onMessage: (m: ServerMessage) => void;
  /** Optional socket.io base URL; defaults to env.socketBase. */
  socketBase?: string;
  clientVersion?: string;
}

export class ChatSocket {
  private socket?: Socket;
  private rejoin?: () => void;
  private disposed = false;

  constructor(private readonly options: ChatSocketOptions) {}

  async connect() {
    if (this.disposed) return;
    const token = await this.options.getToken();
    this.socket = io(this.options.socketBase ?? env.socketBase, {
      transports: ['websocket'],
      withCredentials: true,
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
        'x-product-name': 'Agent Studio',
      },
    });

    this.socket.on('connect', () => this.rejoin?.());
    this.socket.on('message', (m: ServerMessage) => this.options.onMessage(m));
  }

  disconnect() {
    this.disposed = true;
    this.socket?.disconnect();
    this.socket = undefined;
    this.rejoin = undefined;
  }

  private emit(m: ClientMessage) {
    this.socket?.emit('message', m);
  }

  private emitJoin(sessionId: string, lastMessageId?: string) {
    this.emit({
      type: 'join_session',
      id: shortUid(),
      timestamp: Date.now(),
      sessionId,
      lastMessageId,
      version: 2,
    });
  }

  /**
   * Join a session. If a dynamic last-seen id getter is supplied it is used
   * when re-joining after a reconnect, otherwise the static `lastMessageId`
   * is replayed.
   */
  join(sessionId: string, lastMessageId?: string, getLastId?: () => string | undefined) {
    this.rejoin = () => this.emitJoin(sessionId, getLastId?.() ?? lastMessageId);
    this.emitJoin(sessionId, lastMessageId);
  }

  /** Stop sending the join payload after reconnects (e.g. on navigation away). */
  leave(sessionId: string) {
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
