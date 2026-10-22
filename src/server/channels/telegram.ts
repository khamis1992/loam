import { log } from "../../log.js";
import type { Channel, ChannelName, InboundHandler, InboundMessage } from "./types.js";

/**
 * MF11: Telegram channel via the Bot API (long polling getUpdates / sendMessage).
 * The bot token comes ONLY from the env var LOAM_TELEGRAM_BOT_TOKEN; it is never
 * logged or printed. When the var is unset the channel reports itself as
 * "not configured" and never touches the network.
 */

const API_BASE = "https://api.telegram.org";
const ERROR_DELAY_MS = 3000;

/** Subset of a Telegram update we care about (private/group text messages). */
export interface TelegramUpdateLike {
  update_id: number;
  message?: TelegramMessageLike;
  edited_message?: TelegramMessageLike;
}

export interface TelegramMessageLike {
  text?: string;
  date?: number;
  chat?: { id?: number | string };
}

/** Pure mapping from a raw Telegram update to an inbound message (undefined = nothing usable). */
export function updateToInbound(update: TelegramUpdateLike): InboundMessage | undefined {
  const message = update.message ?? update.edited_message;
  const chatId = message?.chat?.id;
  const text = message?.text;
  if (chatId === undefined || typeof text !== "string" || !text.trim()) return undefined;
  const at = typeof message?.date === "number" && message.date > 0
    ? new Date(message.date * 1000).toISOString()
    : undefined;
  return { chatId: String(chatId), text, ...(at ? { at } : {}) };
}

export interface TelegramChannelOptions {
  /** Env source for LOAM_TELEGRAM_BOT_TOKEN (defaults to process.env; override in tests). */
  env?: NodeJS.ProcessEnv;
  /** fetch implementation (defaults to global fetch; override with a mock in tests). */
  fetchImpl?: typeof fetch;
  /** Telegram long-poll timeout in seconds (default 25). */
  pollTimeoutSeconds?: number;
}

export class TelegramChannel implements Channel {
  readonly name: ChannelName = "telegram";
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollTimeoutSeconds: number;
  private handler: InboundHandler | undefined;
  private offset = 0;
  private stopped = true;
  private loop: Promise<void> | undefined;

  constructor(options: TelegramChannelOptions = {}) {
    const env = options.env ?? process.env;
    const raw = env.LOAM_TELEGRAM_BOT_TOKEN;
    const token = typeof raw === "string" ? raw.trim() : "";
    this.token = token ? token : undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 25;
  }

  get configured(): boolean {
    return this.token !== undefined;
  }

  get envVarNames(): readonly string[] {
    return ["LOAM_TELEGRAM_BOT_TOKEN"];
  }

  onInbound(handler: InboundHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (!this.configured) {
      log.info("telegram: not configured — set LOAM_TELEGRAM_BOT_TOKEN to enable");
      return;
    }
    this.stopped = false;
    this.loop = this.pollLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      await this.loop;
    } catch {
      /* pollLoop swallows its own errors */
    } finally {
      this.loop = undefined;
    }
  }

  /** Send an agent reply to a chat. Never logs the token or the request URL. */
  async send(chatId: string, text: string): Promise<void> {
    if (!this.token) throw new Error("telegram channel is not configured (set LOAM_TELEGRAM_BOT_TOKEN)");
    const res = await this.fetchImpl(`${API_BASE}/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) throw new Error(`telegram sendMessage failed with status ${res.status}`);
  }

  /**
   * One long-poll cycle: fetch new updates, dispatch them to the handler and
   * advance the offset. Exposed so tests (and the start loop) can drive it
   * deterministically. Returns the number of dispatched messages.
   */
  async pollOnce(): Promise<number> {
    if (!this.token) return 0;
    const url = `${API_BASE}/bot${this.token}/getUpdates?timeout=${this.pollTimeoutSeconds}&offset=${this.offset}`;
    const res = await this.fetchImpl(url, { method: "GET" });
    if (!res.ok) throw new Error(`telegram getUpdates failed with status ${res.status}`);
    const data = (await res.json()) as { ok?: boolean; result?: TelegramUpdateLike[] };
    if (data.ok !== true) throw new Error("telegram getUpdates returned ok=false");
    const previousOffset = this.offset;
    let dispatched = 0;
    for (const update of data.result ?? []) {
      const updateId = typeof update?.update_id === "number" ? update.update_id : undefined;
      if (updateId !== undefined) this.offset = Math.max(this.offset, updateId + 1);
      // Skip updates already processed on an earlier cycle (defensive dedupe).
      if (updateId !== undefined && updateId < previousOffset) continue;
      const msg = updateToInbound(update);
      if (!msg || !this.handler) continue;
      await this.handler(msg);
      dispatched++;
    }
    return dispatched;
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (err) {
        if (this.stopped) return;
        log.warn(`telegram: poll failed: ${err instanceof Error ? err.message : String(err)}`);
        await new Promise((r) => setTimeout(r, ERROR_DELAY_MS));
      }
    }
  }
}
