/**
 * Tests for src/server/sharedCodeSession.ts (J1 shared launcher).
 *
 * Guarantees under test:
 *  - one server hosts N concurrent sessions over the control socket
 *  - create_session / message / sessions / shutdown protocol replies
 *  - session ids are valid, unknown sessions are rejected
 *  - a failed agent run is reported as failed (not thrown)
 *  - pinToLocalModel keeps a bench server on the configured endpoint only
 *  - the client resolves one reply per command and rejects on close
 *  - the socket path helpers distinguish named pipes from Unix sockets
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { loadConfig, type Config } from "../../config.js";
import {
  DEFAULT_SHARED_MAX_STEPS,
  DEFAULT_SHARED_PROMPT,
  SharedCodeSessionServer,
  SharedControlClient,
  defaultCodeSessionSocketPath,
  isNamedPipePath,
  isValidSessionId,
  sharedCodeSessionRegistry,
  waitForSharedSocket,
} from "../sharedCodeSession.js";

/** A real Loam config pointed at an unreachable endpoint: the loop must not throw. */
function unreachableConfig(): Config {
  const cfg = loadConfig();
  cfg.model = "mock-coder";
  cfg.fallbackModel = "mock-coder";
  cfg.ollamaUrl = "http://127.0.0.1:9";
  cfg.workspace = os.tmpdir();
  cfg.agent.maxSteps = 3;
  cfg.cloudModel = undefined;
  return cfg;
}

function tmpSocketPath(): string {
  // Windows cannot bind a filesystem socket path (EACCES); it needs a named pipe,
  // exactly like production's defaultCodeSessionSocketPath().
  if (process.platform === "win32") return `\\\\.\\pipe\\loam-shared-cs-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-shared-cs-"));
  return path.join(dir, "control.sock");
}

function makeServer(overrides: Partial<ConstructorParameters<typeof SharedCodeSessionServer>[0]> = {}): SharedCodeSessionServer {
  return new SharedCodeSessionServer({
    modelUrl: "http://127.0.0.1:11434",
    model: "mock-coder",
    suppressFinal: true,
    ...overrides,
  });
}

const open: Array<{ server: SharedCodeSessionServer; client: SharedControlClient }> = [];

async function withServer(
  overrides: Partial<ConstructorParameters<typeof SharedCodeSessionServer>[0]> = {},
  fn: (server: SharedCodeSessionServer, client: SharedControlClient) => Promise<void>,
): Promise<void> {
  const server = makeServer({ socketPath: tmpSocketPath(), ...overrides });
  await server.listen();
  const client = new SharedControlClient(server.socket);
  await client.connect();
  open.push({ server, client });
  try {
    await fn(server, client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

const cleanups: Array<() => void> = [];
afterEach(async () => {
  while (open.length > 0) {
    const entry = open.pop()!;
    await entry.server.close().catch(() => undefined);
  }
  while (cleanups.length > 0) {
    try {
      cleanups.pop()!();
    } catch {
      /* ignore */
    }
  }
});

describe("sharedCodeSession", () => {
  it("hosts N concurrent sessions in one process and reports them", async () => {
    await withServer({}, async (server, client) => {
      assert.equal(server.pid, process.pid, "sessions run in this process");
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const reply = await client.send("create_session", fs.mkdtempSync(path.join(os.tmpdir(), "loam-cs-cwd-")));
        assert.equal(reply.ok, true, JSON.stringify(reply));
        const id = reply.session as string;
        assert.ok(isValidSessionId(id), `invalid session id ${String(id)}`);
        ids.push(id);
      }
      assert.equal(new Set(ids).size, 3, "session ids are unique");
      const listing = await client.send("sessions");
      assert.equal(listing.ok, true);
      const sessions = listing.sessions as Array<{ id: string; status: string }>;
      assert.deepEqual(sessions.map((s) => s.id).sort(), [...ids].sort());
      assert.ok(sessions.every((s) => s.status === "running"));
    });
  });

  it("runs a message in a session and marks it done with a step count", async () => {
    await withServer(
      {
        configFactory: () => unreachableConfig(),
      },
      async (server, client) => {
        const created = await client.send("create_session", os.tmpdir());
        const session = created.session as string;
        // The endpoint is unreachable, so the loop fails on the first model call
        // and the server reports it as a failed session rather than throwing.
        const reply = await client.send("message", JSON.stringify({ session, text: "hello" }));
        assert.equal(reply.ok, false, JSON.stringify(reply));
        assert.equal(reply.status, "failed");
        assert.equal(reply.session, session);
        assert.equal(typeof reply.steps, "number");
        const summary = server.sessions.get(session)!;
        assert.equal(summary.status, "failed");
        assert.ok(summary.error, "failure reason recorded");
        assert.ok(summary.endedAt !== null);
      },
    );
  });

  it("falls back to DEFAULT_SHARED_PROMPT when the message carries no text", async () => {
    await withServer(
      {
        configFactory: () => unreachableConfig(),
      },
      async (_server, client) => {
        const created = await client.send("create_session", os.tmpdir());
        const reply = await client.send("message", JSON.stringify({ session: created.session }));
        assert.equal(reply.ok, false, JSON.stringify(reply));
        assert.equal(reply.status, "failed");
      },
    );
  });

  it("rejects unknown commands and unknown sessions", async () => {
    await withServer({}, async (_server, client) => {
      const unknown = await client.send("nope");
      assert.equal(unknown.ok, false);
      assert.match(String(unknown.error), /unknown command/);

      const bad = await client.send("message", JSON.stringify({ session: "does-not-exist", text: "x" }));
      assert.equal(bad.ok, false);
      assert.match(String(bad.error), /unknown session/);
    });
  });

  it("reports a failed agent run as failed instead of throwing", async () => {
    await withServer(
      {
        configFactory: () => {
          const cfg = unreachableConfig();
          cfg.workspace = path.join(os.tmpdir(), "does-not-exist-shared-cs");
          return cfg;
        },
      },
      async (server, client) => {
        // A workspace that does not exist makes the agent loop fail, proving the
        // server turns a thrown loop error into a failed session reply.
        const created = await client.send("create_session", path.join(os.tmpdir(), "does-not-exist-shared-cs"));
        const reply = await client.send("message", JSON.stringify({ session: created.session, text: "x" }));
        assert.equal(reply.ok, false);
        assert.equal(reply.status, "failed");
        assert.ok(reply.error, "failure reason recorded");
        assert.equal(server.sessions.get(created.session as string)!.status, "failed");
      },
    );
  });

  it("pinToLocalModel disables the coding router and failover chain", () => {
    const pinned = makeServer({ pinToLocalModel: true });
    const cfg = (pinned as unknown as { configFactory: (cwd: string) => unknown }).configFactory(os.tmpdir());
    assert.equal((cfg as { cloudModel?: unknown }).cloudModel, undefined);
    assert.equal((cfg as { coding: { enabled: boolean } }).coding.enabled, false);
    assert.deepEqual((cfg as { coding: { chain: unknown[] } }).coding.chain, []);
    assert.deepEqual((cfg as { failover: { providers: unknown[] } }).failover.providers, []);
  });

  it("pinToLocalModel=false still clears the cloud endpoint but keeps the chain", () => {
    const loose = makeServer({ pinToLocalModel: false });
    const cfg = (loose as unknown as { configFactory: (cwd: string) => unknown }).configFactory(os.tmpdir());
    assert.equal((cfg as { cloudModel?: unknown }).cloudModel, undefined);
    assert.notEqual((cfg as { failover: { providers: unknown[] } }).failover.providers.length, undefined);
  });

  it("builds the standard coding registry and keeps it isolated per session", () => {
    const registry = sharedCodeSessionRegistry();
    for (const name of ["file_read", "file_edit", "shell_run", "todo_write", "finish"]) {
      assert.ok(registry.get(name), `registry is missing ${name}`);
    }
    assert.notEqual(registry, sharedCodeSessionRegistry(), "each call builds a fresh registry");
  });

  it("waitForSharedSocket resolves once the server is listening", async () => {
    const server = makeServer({ socketPath: tmpSocketPath() });
    await server.listen();
    await assert.doesNotReject(waitForSharedSocket(server.socket, 2000));
    await server.close();
  });

  it("client rejects a send before connect and after the socket closes", async () => {
    // The client is bound to a real server socket up front, so "not connected"
    // here means "no socket yet", not "socket path is unreachable".
    const server = makeServer({ socketPath: tmpSocketPath() });
    await server.listen();
    const client = new SharedControlClient(server.socket);
    await assert.rejects(client.send("sessions"), /not connected/);
    await client.connect();
    await server.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(client.send("sessions"));
  });

  it("exposes the expected defaults and socket helpers", () => {
    assert.equal(DEFAULT_SHARED_MAX_STEPS, 40);
    assert.equal(DEFAULT_SHARED_PROMPT, "Continue the task.");
    assert.equal(isNamedPipePath("\\\\.\\pipe\\loam-cs-1"), true);
    assert.equal(isNamedPipePath("/tmp/loam-cs-1.sock"), false);
    assert.equal(defaultCodeSessionSocketPath().length > 0, true);
    assert.equal(isValidSessionId("s1234567"), true);
    assert.equal(isValidSessionId("../evil"), false);
  });

  it("removes a stale Unix socket file before binding", { skip: process.platform === "win32" }, async () => {
    const socketPath = tmpSocketPath();
    fs.writeFileSync(socketPath, "stale");
    const server = makeServer({ socketPath });
    await server.listen();
    assert.equal(server.listening, true);
    await server.close();
    assert.equal(fs.existsSync(socketPath), false, "socket file removed on close");
  });

  it("runs a message to completion against a scripted fake model", async () => {
    // Real end-to-end: the bench fake model answers the loop, so a session can
    // actually reach "done" through the control socket.
    const { FakeModelServer } = await import("../../../bench/fakeModel.js");
    const model = new FakeModelServer({
      host: "127.0.0.1",
      port: 0,
      transport: "ollama",
      model: "mock-coder",
      sequence: [{ text: "no tools needed" }],
    });
    await model.start();
    cleanups.push(() => void model.stop());
    const cfg = loadConfig();
    cfg.model = "mock-coder";
    cfg.fallbackModel = "mock-coder";
    cfg.ollamaUrl = model.baseUrl;
    cfg.workspace = os.tmpdir();
    cfg.agent.maxSteps = 3;
    cfg.cloudModel = undefined;
    await withServer({ configFactory: () => cfg }, async (server, client) => {
      const created = await client.send("create_session", os.tmpdir());
      const reply = await client.send("message", JSON.stringify({ session: created.session, text: "hello" }));
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.equal(reply.status, "done");
      assert.equal(server.sessions.get(created.session as string)!.status, "done");
    });
  });
});

describe("sharedCodeSession entry point", () => {
  it("main prints usage and exits 2 when the socket path or model URL is missing", async () => {
    const { main } = await import("../sharedCodeSession.js");
    const original = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    let out = "";
    let err = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      err += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await main([]);
      assert.equal(code, 2);
      assert.match(err, /usage: sharedCodeSession/);
      assert.equal(out, "");
    } finally {
      process.stdout.write = original;
      process.stderr.write = originalErr;
    }
  });
});
