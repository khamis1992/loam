import { log } from "../../log.js";
import type { Channel, ChannelName, InboundHandler, InboundMessage } from "./types.js";

/**
 * MF11: email channel with an IMAP/SMTP-style provider abstraction.
 * Only the Mock provider is implemented — it never touches the network and
 * never sends a real message. The IMAP/SMTP provider reports its configuration
 * from LOAM_EMAIL_* env vars but its I/O is intentionally unimplemented.
 */

export interface EmailInbound {
  /** Sender address; used as the chat id for routing and replies. */
  from: string;
  subject?: string;
  text: string;
  at?: string;
}

export interface EmailOutbound {
  to: string;
  subject: string;
  text: string;
  at: string;
}

export type EmailInboundCallback = (msg: EmailInbound) => void | Promise<void>;

export interface EmailProvider {
  readonly name: string;
  readonly configured: boolean;
  readonly envVarNames: readonly string[];
  onInbound(cb: EmailInboundCallback): void;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  send(to: string, subject: string, text: string): Promise<void>;
}

/** Env vars a real IMAP/SMTP deployment needs (mock ignores them). */
export const EMAIL_ENV_VARS = [
  "LOAM_EMAIL_PROVIDER",
  "LOAM_EMAIL_IMAP_HOST",
  "LOAM_EMAIL_IMAP_PORT",
  "LOAM_EMAIL_SMTP_HOST",
  "LOAM_EMAIL_SMTP_PORT",
  "LOAM_EMAIL_USER",
  "LOAM_EMAIL_PASSWORD",
] as const;

/**
 * Offline mock provider: inbound messages are delivered in-process via
 * `deliver()` (test/fixture hook) and outgoing mail is recorded in an
 * in-memory outbox. Never performs any network I/O.
 */
export class MockEmailProvider implements EmailProvider {
  readonly name = "mock";
  readonly configured = true;
  readonly envVarNames: readonly string[] = ["LOAM_EMAIL_PROVIDER"];
  private callback: EmailInboundCallback | undefined;
  private readonly outbox: EmailOutbound[] = [];

  onInbound(cb: EmailInboundCallback): void {
    this.callback = cb;
  }

  start(): void {
    /* nothing to poll — inbound arrives via deliver() */
  }

  stop(): void {
    /* nothing to release */
  }

  /** Record an outbound message in the in-memory outbox (no real send). */
  async send(to: string, subject: string, text: string): Promise<void> {
    this.outbox.push({ to, subject, text, at: new Date().toISOString() });
  }

  /** Test/fixture hook: simulate an inbound email arriving (awaitable when the handler is async). */
  deliver(msg: EmailInbound): void | Promise<void> {
    return this.callback?.(msg);
  }

  getOutbox(): readonly EmailOutbound[] {
    return [...this.outbox];
  }

  clearOutbox(): void {
    this.outbox.length = 0;
  }
}

/**
 * IMAP/SMTP-style provider placeholder: reads its configuration from
 * LOAM_EMAIL_* env vars but performs no IMAP/SMTP I/O yet (no real send).
 * Replace the throwing bodies with a real client before pointing it at a
 * live mailbox.
 */
export class ImapSmtpEmailProvider implements EmailProvider {
  readonly name = "imap-smtp";
  readonly configured: boolean;
  readonly envVarNames: readonly string[] = EMAIL_ENV_VARS;
  private callback: EmailInboundCallback | undefined;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.configured = Boolean(
      env.LOAM_EMAIL_IMAP_HOST?.trim() && env.LOAM_EMAIL_SMTP_HOST?.trim() && env.LOAM_EMAIL_USER?.trim(),
    );
  }

  onInbound(cb: EmailInboundCallback): void {
    this.callback = cb;
  }

  start(): void {
    if (this.configured) {
      log.warn("email: imap-smtp provider is not implemented yet; inbound polling is disabled");
    }
  }

  stop(): void {
    /* nothing to release */
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    void to;
    void subject;
    void text;
    throw new Error("email: real IMAP/SMTP sending is not implemented; use LOAM_EMAIL_PROVIDER=mock");
  }
}

/** Pick the provider from LOAM_EMAIL_PROVIDER (default: mock, never a real send). */
export function createEmailProvider(env: NodeJS.ProcessEnv = process.env): EmailProvider {
  const kind = (env.LOAM_EMAIL_PROVIDER ?? "mock").trim().toLowerCase();
  return kind === "mock" || kind === "" ? new MockEmailProvider() : new ImapSmtpEmailProvider(env);
}

/** Email channel: chat id == email address. Replies go out through the provider. */
export class EmailChannel implements Channel {
  readonly name: ChannelName = "email";
  private readonly provider: EmailProvider;
  private handler: InboundHandler | undefined;

  constructor(provider: EmailProvider = createEmailProvider()) {
    this.provider = provider;
  }

  get configured(): boolean {
    return this.provider.configured;
  }

  get envVarNames(): readonly string[] {
    return this.provider.envVarNames;
  }

  get providerName(): string {
    return this.provider.name;
  }

  onInbound(handler: InboundHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (!this.configured) return;
    this.provider.onInbound((msg) => {
      const chatId = msg.from.trim();
      if (!chatId || !this.handler) return;
      const inbound: InboundMessage = {
        chatId,
        text: msg.subject ? `${msg.subject}\n\n${msg.text}` : msg.text,
        ...(msg.at ? { at: msg.at } : {}),
      };
      return this.handler(inbound);
    });
    await this.provider.start();
  }

  async stop(): Promise<void> {
    await this.provider.stop();
  }

  async send(chatId: string, text: string): Promise<void> {
    await this.provider.send(chatId, "Loam", text);
  }
}
