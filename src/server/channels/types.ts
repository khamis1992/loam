/** MF11: messaging channels — Telegram first, plus email. */

/** Channels Loam can bind to an agent. */
export type ChannelName = "telegram" | "email";

/** A normalized message arriving from any channel. */
export interface InboundMessage {
  /** Telegram chat id (as string) or the sender's email address. */
  chatId: string;
  text: string;
  at?: string;
}

export type InboundHandler = (msg: InboundMessage) => void | Promise<void>;

/** A messaging channel: receives inbound messages and delivers agent replies. */
export interface Channel {
  readonly name: ChannelName;
  /** True when the required credentials (env vars) are present. */
  readonly configured: boolean;
  /** Env var names needed to configure this channel. */
  readonly envVarNames: readonly string[];
  /** Register the handler invoked for every inbound message. */
  onInbound(handler: InboundHandler): void;
  /** Begin receiving (long polling / mailbox listening). No-op when not configured. */
  start(): Promise<void>;
  /** Stop receiving and release resources. */
  stop(): Promise<void>;
  /** Deliver an agent reply to the given chat id. */
  send(chatId: string, text: string): Promise<void>;
}

/** What GET /api/channels reports per channel. */
export interface ChannelStatusSummary {
  name: ChannelName;
  configured: boolean;
  envVarNames: string[];
  /** Human hint shown in the UI when not configured. */
  hint?: string;
}
