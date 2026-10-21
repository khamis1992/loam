import assert from "node:assert";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { describe, it, before, after } from "node:test";

import type { Channel, ChannelName, InboundHandler, InboundMessage } from "../channels/types.js";
import type { MockEmailProvider } from "../channels/email.js";
import type { TelegramChannel } from "../channels/telegram.js";
import type { ChannelBinding } from "../channels/router.js";

let tmpDir = "";
let closeDb: () => void;

let telegram: typeof import("../channels/telegram.js");
let email: typeof import("../channels/email.js");
let router: typeof import("../channels/router.js");
let routes: typeof import("../routes/channels.js");
let db: typeof import("../db.js");
let agents: typeof import("../agents.js");

interface MockResponseInit {
  status?: number;
  body?: unknown;
}

/** Deterministic fetch mock that records requests and replies from a queue. */
function mockFetch(responses: MockResponseInit[]) {
  const calls: Array<{ url: string; init?: RequestInit; body?: unknown }> = [];
  const queue = [...responses];
  const impl = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    const parsedBody = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url: String(url), init, body: parsedBody });
    const next = queue.length > 0 ? queue.shift()! : { status: 200, body: { ok: true, result: [] } };
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      json: async () => next.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Channel stub used to drive the router deterministically. */
class FakeChannel implements Channel {
  readonly name: ChannelName;
  readonly configured = true;
  readonly envVarNames: readonly string[] = [];
  handler: InboundHandler | undefined;
  readonly sent: Array<{ chatId: string; text: string }> = [];

  constructor(name: ChannelName) {
    this.name = name;
  }

  onInbound(handler: InboundHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async send(chatId: string, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }

  async emit(msg: InboundMessage): Promise<void> {
    await this.handler?.(msg);
  }
}

class FakeRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";

  writeHead(status: number, headers?: Record<string, string>): void {
    this.statusCode = status;
    if (headers) this.headers = headers;
  }

  end(text?: string): void {
    this.body = text ?? "";
  }

  json(): unknown {
    return JSON.parse(this.body) as unknown;
  }
}

function fakeReq(method: string, body?: unknown): http.IncomingMessage {
  const req = new EventEmitter() as unknown as http.IncomingMessage;
  const patch = req as unknown as Record<string, unknown>;
  patch.method = method;
  patch.destroy = () => req;
  queueMicrotask(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

describe("channels (MF11)", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-channels-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    delete process.env.LOAM_TELEGRAM_BOT_TOKEN;
    delete process.env.LOAM_EMAIL_PROVIDER;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    telegram = await import("../channels/telegram.js");
    email = await import("../channels/email.js");
    router = await import("../channels/router.js");
    routes = await import("../routes/channels.js");
    db = await import("../db.js");
    agents = await import("../agents.js");
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe("telegram channel", () => {
    it("is not configured without LOAM_TELEGRAM_BOT_TOKEN", () => {
      const tg = new telegram.TelegramChannel({ env: {} });
      assert.equal(tg.configured, false);
      assert.deepStrictEqual([...tg.envVarNames], ["LOAM_TELEGRAM_BOT_TOKEN"]);
    });

    it("maps raw updates to inbound messages", () => {
      const msg = telegram.updateToInbound({ update_id: 1, message: { text: "hi", date: 1700000000, chat: { id: 42 } } });
      assert.ok(msg);
      assert.equal(msg!.chatId, "42");
      assert.equal(msg!.text, "hi");
      assert.equal(msg!.at, new Date(1700000000 * 1000).toISOString());
      assert.equal(telegram.updateToInbound({ update_id: 2, message: { chat: { id: 1 } } }), undefined);
      assert.equal(telegram.updateToInbound({ update_id: 3, message: { text: "  ", chat: { id: 1 } } }), undefined);
    });

    it("polls getUpdates with a mock fetch and dispatches to the handler", async () => {
      const { impl, calls } = mockFetch([
        { body: { ok: true, result: [{ update_id: 7, message: { text: "hello", date: 1700000000, chat: { id: 42 } } }] } },
        { body: { ok: true, result: [] } },
      ]);
      const tg = new telegram.TelegramChannel({ env: { LOAM_TELEGRAM_BOT_TOKEN: "secret-token" }, fetchImpl: impl });
      assert.equal(tg.configured, true);

      const seen: InboundMessage[] = [];
      tg.onInbound((msg) => {
        seen.push(msg);
      });

      assert.equal(await tg.pollOnce(), 1);
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.chatId, "42");
      assert.equal(seen[0]!.text, "hello");
      // Second cycle: same update is deduped by offset, nothing re-dispatched.
      assert.equal(await tg.pollOnce(), 0);
      assert.equal(seen.length, 1);
      // The polling request hit the Bot API getUpdates endpoint.
      assert.ok(calls[0]!.url.startsWith("https://api.telegram.org/botsecret-token/getUpdates"));
    });

    it("sends replies via sendMessage with the right chat id", async () => {
      const { impl, calls } = mockFetch([{ body: { ok: true } }]);
      const tg = new telegram.TelegramChannel({ env: { LOAM_TELEGRAM_BOT_TOKEN: "secret-token" }, fetchImpl: impl });
      await tg.send("42", "reply text");
      assert.equal(calls.length, 1);
      assert.ok(calls[0]!.url.endsWith("/sendMessage"));
      assert.deepStrictEqual(calls[0]!.body, { chat_id: "42", text: "reply text" });
    });

    it("throws without touching the network when not configured", async () => {
      const { impl, calls } = mockFetch([]);
      const tg = new telegram.TelegramChannel({ env: {}, fetchImpl: impl });
      await assert.rejects(() => tg.send("42", "x"), /not configured/);
      assert.equal(calls.length, 0);
      await tg.start(); // no-op when unconfigured
      assert.equal(await tg.pollOnce(), 0);
      assert.equal(calls.length, 0);
    });
  });

  describe("router bindings", () => {
    let agentId: string;
    let telegramChannel: FakeChannel;
    let emailChannel: FakeChannel;
    let turnCalls: Array<{ taskId: string; prompt: string; agentId: string }>;
    let stopRouter: (() => void) | undefined;

    before(() => {
      const agent = agents.createAgent({ name: "Channels Agent" });
      agentId = agent.id;
    });

    after(() => {
      stopRouter?.();
      stopRouter = undefined;
    });

    function startRouter(reply = "agent reply"): void {
      stopRouter?.();
      turnCalls = [];
      const tg = new FakeChannel("telegram");
      const em = new FakeChannel("email");
      telegramChannel = tg;
      emailChannel = em;
      stopRouter = router.startChannelRouter({
        channels: [tg, em],
        runAgentTurn: async (o) => {
          turnCalls.push(o);
          return reply;
        },
      });
    }

    it("ignores inbound from an unbound chat (allowlist)", async () => {
      startRouter();
      const before = db.listTasks().length;
      await telegramChannel.emit({ chatId: "999", text: "anyone out there?" });
      assert.equal(db.listTasks().length, before);
      assert.equal(turnCalls.length, 0);
      assert.equal(telegramChannel.sent.length, 0);
    });

    it("creates an agent task from inbound and replies through the channel", async () => {
      startRouter();
      const binding = router.createBinding("telegram", "42", agentId);
      assert.equal(binding.channel, "telegram");
      assert.equal(binding.chatId, "42");
      assert.equal(binding.agentId, agentId);

      await telegramChannel.emit({ chatId: "42", text: "please summarize the report" });

      assert.equal(turnCalls.length, 1);
      const turn = turnCalls[0]!;
      assert.equal(turn.agentId, agentId);
      assert.equal(turn.prompt, "please summarize the report");
      // The task was created on the agent's permanent thread (agentId set).
      const task = db.getTask(turn.taskId);
      assert.ok(task);
      assert.equal(task!.agentId, agentId);
      assert.equal(task!.prompt, "please summarize the report");
      // The reply went back through the channel to the right chat.
      assert.deepStrictEqual(telegramChannel.sent, [{ chatId: "42", text: "agent reply" }]);
    });

    it("rebinding the same chat re-points it at the new agent", () => {
      startRouter();
      const other = agents.createAgent({ name: "Other Agent" });
      const first = router.createBinding("email", "a@x.test", agentId);
      const second = router.createBinding("email", "a@x.test", other.id);
      assert.equal(router.findBinding("email", "a@x.test")!.agentId, other.id);
      assert.notEqual(first.id, second.id);
      // The old binding id no longer resolves after the upsert.
      assert.equal(router.getBinding(first.id), undefined);
    });

    it("validates bindings: unknown channel, empty chat, missing agent", () => {
      assert.throws(() => router.createBinding("carrier-pigeon" as ChannelName, "1", agentId), /unknown channel/);
      assert.throws(() => router.createBinding("telegram", "   ", agentId), /chatId is required/);
      assert.throws(() => router.createBinding("telegram", "1", "no-such-agent"), /agent not found/);
    });

    it("deletes bindings", () => {
      const binding = router.createBinding("telegram", "77", agentId);
      assert.equal(router.deleteBinding(binding.id), true);
      assert.equal(router.findBinding("telegram", "77"), undefined);
      assert.equal(router.deleteBinding(binding.id), false);
    });
  });

  describe("email channel (mock provider)", () => {
    it("routes inbound email into a task and records the reply in the outbox (no real send)", async () => {
      const agent = agents.createAgent({ name: "Mail Agent" });
      router.createBinding("email", "khamis@example.test", agent.id);

      const mock = new email.MockEmailProvider();
      const channel = new email.EmailChannel(mock);
      const wired = new router.ChannelRouter([channel], {
        runAgentTurn: async () => "here is the summary",
      });
      await wired.start();

      // Unbound address: silently ignored (allowlist).
      await mock.deliver({ from: "stranger@example.test", text: "hello?" });
      assert.equal(mock.getOutbox().length, 0);

      // Bound address: task + reply recorded in the outbox, no real send.
      await mock.deliver({ from: "khamis@example.test", subject: "Summarize", text: "please summarize today" });
      const outbox = mock.getOutbox();
      assert.equal(outbox.length, 1);
      assert.equal(outbox[0]!.to, "khamis@example.test");
      assert.equal(outbox[0]!.text, "here is the summary");
      await wired.stop();
    });

    it("configures the imap-smtp provider from LOAM_EMAIL_* env vars", () => {
      const notConfigured = new email.ImapSmtpEmailProvider({ LOAM_EMAIL_IMAP_HOST: "" });
      assert.equal(notConfigured.configured, false);
      const configured = new email.ImapSmtpEmailProvider({
        LOAM_EMAIL_IMAP_HOST: "imap.example.test",
        LOAM_EMAIL_SMTP_HOST: "smtp.example.test",
        LOAM_EMAIL_USER: "khamis@example.test",
      });
      assert.equal(configured.configured, true);
      assert.ok(configured.envVarNames.includes("LOAM_EMAIL_PASSWORD"));
      assert.rejects(() => configured.send("a@b.c", "s", "t"), /not implemented/);
      assert.equal(email.createEmailProvider({}).name, "mock");
      assert.equal(email.createEmailProvider({ LOAM_EMAIL_PROVIDER: "imap-smtp" }).name, "imap-smtp");
    });
  });

  describe("routes", () => {
    let agentId: string;

    before(() => {
      agentId = agents.createAgent({ name: "Route Agent" }).id;
    });

    it("GET /api/channels reports status and env var names", async () => {
      const res = new FakeRes();
      await routes.handleChannelRoutes(fakeReq("GET"), res as unknown as http.ServerResponse, "/api/channels");
      assert.equal(res.statusCode, 200);
      const body = res.json() as { channels: Array<{ name: string; configured: boolean; envVarNames: string[]; hint?: string }> };
      const names = body.channels.map((c) => c.name).sort();
      assert.deepStrictEqual(names, ["email", "telegram"]);
      const tg = body.channels.find((c) => c.name === "telegram")!;
      assert.equal(tg.configured, false);
      assert.deepStrictEqual(tg.envVarNames, ["LOAM_TELEGRAM_BOT_TOKEN"]);
      assert.match(tg.hint ?? "", /LOAM_TELEGRAM_BOT_TOKEN/);
    });

    it("binds, lists and unbinds a chat for an agent", async () => {
      const res1 = new FakeRes();
      await routes.handleChannelRoutes(
        fakeReq("POST", { channel: "telegram", chatId: " 555 " }),
        res1 as unknown as http.ServerResponse,
        `/api/agents/${agentId}/channels`,
      );
      assert.equal(res1.statusCode, 200);
      const binding = (res1.json() as { binding: ChannelBinding }).binding;
      assert.equal(binding.chatId, "555");
      assert.equal(binding.agentId, agentId);

      const res2 = new FakeRes();
      await routes.handleChannelRoutes(
        fakeReq("GET"),
        res2 as unknown as http.ServerResponse,
        `/api/agents/${agentId}/channels`,
      );
      assert.equal(res2.statusCode, 200);
      assert.equal((res2.json() as { bindings: unknown[] }).bindings.length, 1);

      const res3 = new FakeRes();
      await routes.handleChannelRoutes(
        fakeReq("DELETE"),
        res3 as unknown as http.ServerResponse,
        `/api/agents/${agentId}/channels/${binding.id}`,
      );
      assert.equal(res3.statusCode, 200);
      assert.equal((res3.json() as { deleted: boolean }).deleted, true);
      assert.equal(router.listBindings(agentId).length, 0);
    });

    it("rejects invalid payloads and unknown agents/bindings", async () => {
      const bad = new FakeRes();
      await routes.handleChannelRoutes(
        fakeReq("POST", { channel: "sms" }),
        bad as unknown as http.ServerResponse,
        `/api/agents/${agentId}/channels`,
      );
      assert.equal(bad.statusCode, 400);

      const missingAgent = new FakeRes();
      await routes.handleChannelRoutes(
        fakeReq("POST", { channel: "telegram", chatId: "1" }),
        missingAgent as unknown as http.ServerResponse,
        "/api/agents/ghost/channels",
      );
      assert.equal(missingAgent.statusCode, 404);

      const missingBinding = new FakeRes();
      await routes.handleChannelRoutes(
        fakeReq("DELETE"),
        missingBinding as unknown as http.ServerResponse,
        `/api/agents/${agentId}/channels/binding_nope`,
      );
      assert.equal(missingBinding.statusCode, 404);
    });

    it("ignores unrelated paths so the dispatcher can fall through", async () => {
      const res = new FakeRes();
      const handled = await routes.handleChannelRoutes(
        fakeReq("GET"),
        res as unknown as http.ServerResponse,
        "/api/agents",
      );
      assert.equal(handled, false);
    });
  });

  describe("types module", () => {
    it("exports the channel names", () => {
      assert.deepStrictEqual([...router.CHANNEL_NAMES], ["telegram", "email"]);
    });
  });
});
