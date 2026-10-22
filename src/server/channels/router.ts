import { database } from "../sqliteStore.js";
import { createTask, getTask } from "../db.js";
import { getAgent } from "../agents.js";
import { log } from "../../log.js";
import { TelegramChannel } from "./telegram.js";
import { EmailChannel } from "./email.js";
import type { Channel, ChannelName, ChannelStatusSummary, InboundMessage } from "./types.js";

/**
 * MF11: channel router — binds a channel+chat to an agent.
 *
 * A binding row doubles as the allowlist of chat ids: an inbound message from
 * a chat id without a binding is silently ignored. Binding (channel, chatId)
 * is unique; binding the same chat again re-points it at the new agent.
 */

export const CHANNEL_NAMES: readonly ChannelName[] = ["telegram", "email"];

export interface ChannelBinding {
  id: string;
  channel: ChannelName;
  chatId: string;
  agentId: string;
  createdAt: string;
}

function ensureTable(): void {
  database().exec(`CREATE TABLE IF NOT EXISTS channel_bindings (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(channel, chat_id)
  );`);
}

interface BindingRow {
  id: string;
  channel: string;
  chat_id: string;
  agent_id: string;
  created_at: string;
}

function fromRow(row: BindingRow): ChannelBinding {
  return { id: row.id, channel: row.channel as ChannelName, chatId: row.chat_id, agentId: row.agent_id, createdAt: row.created_at };
}

const SELECT_COLUMNS = "id, channel, chat_id, agent_id, created_at";

export function isChannelName(value: unknown): value is ChannelName {
  return typeof value === "string" && (CHANNEL_NAMES as readonly string[]).includes(value);
}

export function listBindings(agentId?: string): ChannelBinding[] {
  ensureTable();
  const db = database();
  const rows = agentId === undefined
    ? (db.prepare(`SELECT ${SELECT_COLUMNS} FROM channel_bindings ORDER BY created_at ASC, id ASC`).all() as unknown as BindingRow[])
    : (db.prepare(`SELECT ${SELECT_COLUMNS} FROM channel_bindings WHERE agent_id = ? ORDER BY created_at ASC, id ASC`).all(agentId) as unknown as BindingRow[]);
  return rows.map(fromRow);
}

export function getBinding(id: string): ChannelBinding | undefined {
  ensureTable();
  const row = database().prepare(`SELECT ${SELECT_COLUMNS} FROM channel_bindings WHERE id = ?`).get(id) as BindingRow | undefined;
  return row ? fromRow(row) : undefined;
}

/** The (channel, chatId) table IS the allowlist: an unbound chat never routes. */
export function findBinding(channel: ChannelName, chatId: string): ChannelBinding | undefined {
  ensureTable();
  const row = database().prepare(`SELECT ${SELECT_COLUMNS} FROM channel_bindings WHERE channel = ? AND chat_id = ?`)
    .get(channel, chatId) as BindingRow | undefined;
  return row ? fromRow(row) : undefined;
}

export function createBinding(channel: ChannelName, chatId: string, agentId: string): ChannelBinding {
  ensureTable();
  if (!isChannelName(channel)) throw new Error("unknown channel");
  const chat = chatId.trim();
  if (!chat) throw new Error("chatId is required");
  if (chat.length > 256) throw new Error("chatId too long");
  if (!getAgent(agentId)) throw new Error("agent not found");
  const now = new Date().toISOString();
  const id = "binding_" + now.replace(/[^0-9]/g, "").slice(0, 14) + Math.random().toString(36).slice(2, 10);
  database()
    .prepare(`INSERT INTO channel_bindings (id, channel, chat_id, agent_id, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(channel, chat_id) DO UPDATE SET id = excluded.id, agent_id = excluded.agent_id, created_at = excluded.created_at`)
    .run(id, channel, chat, agentId, now);
  return getBinding(id)!;
}

export function deleteBinding(id: string): boolean {
  ensureTable();
  return Number(database().prepare("DELETE FROM channel_bindings WHERE id = ?").run(id).changes) > 0;
}

/** Deps for turning an inbound message into an agent run + channel reply. */
export interface ChannelRouterDeps {
  /**
   * The existing task-creation path: the router creates the task itself
   * (createTask under the agent's id = its permanent thread) and deps run it.
   * Returns the agent's reply text to send back through the channel.
   */
  runAgentTurn?: (o: { taskId: string; prompt: string; agentId: string }) => Promise<string>;
  /** Channel overrides (tests inject mock-backed channels). */
  channels?: Channel[];
}

export class ChannelRouter {
  readonly channels: Channel[];
  private readonly deps: ChannelRouterDeps;

  constructor(channels: Channel[], deps: ChannelRouterDeps = {}) {
    this.channels = channels;
    this.deps = deps;
  }

  async start(): Promise<void> {
    for (const channel of this.channels) {
      channel.onInbound((msg) => this.handleInbound(channel, msg));
      await channel.start();
    }
  }

  async stop(): Promise<void> {
    for (const channel of this.channels) {
      try {
        await channel.stop();
      } catch (err) {
        log.warn(`channels: stop ${channel.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Route one inbound message. Unbound chats are ignored (allowlist). */
  async handleInbound(channel: Channel, msg: InboundMessage): Promise<void> {
    const chatId = msg.chatId.trim();
    if (!chatId) return;
    const binding = findBinding(channel.name, chatId);
    if (!binding) return; // allowlist: chat id not bound -> ignore
    const agent = getAgent(binding.agentId);
    if (!agent) return;
    const text = msg.text;
    if (!text.trim()) return;
    // Existing task-creation path: the task carries the agent id, so it lands
    // in that agent's permanent thread (one-thread-per-agent continuity).
    const task = createTask(text, `${channel.name}: ${text.slice(0, 60)}`, null, binding.agentId);
    log.info(`channels: ${channel.name} inbound chat=${chatId} -> task=${task.id} agent=${binding.agentId}`);
    const runAgentTurn = this.deps.runAgentTurn;
    if (!runAgentTurn) return;
    try {
      const reply = await runAgentTurn({ taskId: task.id, prompt: text, agentId: binding.agentId });
      const trimmed = typeof reply === "string" ? reply.trim() : "";
      if (!trimmed) return;
      const ran = getTask(task.id);
      if (!ran) return;
      await channel.send(chatId, trimmed);
    } catch (err) {
      log.warn(`channels: ${channel.name} turn failed for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

let active: ChannelRouter | undefined;

/**
 * Build and start the default router (Telegram + Email, env-configured).
 * Returns a stop function. Tests pass explicit `channels` instead.
 */
export function startChannelRouter(deps: ChannelRouterDeps = {}): () => void {
  const channels = deps.channels ?? [new TelegramChannel(), new EmailChannel()];
  const router = new ChannelRouter(channels, deps);
  active = router;
  void router.start();
  return () => {
    if (active === router) active = undefined;
    void router.stop();
  };
}

export function getActiveChannelRouter(): ChannelRouter | undefined {
  return active;
}

function statusOf(channel: Channel): ChannelStatusSummary {
  const hint = channel.configured
    ? undefined
    : channel.name === "telegram"
      ? "Not configured — set LOAM_TELEGRAM_BOT_TOKEN (token from @BotFather)"
      : "Not configured — set LOAM_EMAIL_PROVIDER (mock is always on; imap-smtp needs LOAM_EMAIL_IMAP_HOST, LOAM_EMAIL_SMTP_HOST, LOAM_EMAIL_USER)";
  return {
    name: channel.name,
    configured: channel.configured,
    envVarNames: [...channel.envVarNames],
    ...(hint ? { hint } : {}),
  };
}

/** Status for GET /api/channels — reflects the active router when started, env otherwise. */
export function channelStatus(): ChannelStatusSummary[] {
  if (active) return active.channels.map(statusOf);
  return [new TelegramChannel(), new EmailChannel()].map(statusOf);
}
