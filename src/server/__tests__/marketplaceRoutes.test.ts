import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";

let tmpDir = "";
let closeDb: () => void;
let routes: typeof import("../routes/marketplace.js");
let agents: typeof import("../agents.js");

interface Captured {
  status?: number;
  body?: unknown;
}

function fakeRes(): { res: http.ServerResponse; captured: Captured } {
  const captured: Captured = {};
  const res = {
    writeHead(status: number) { captured.status = status; return res; },
    end(text?: unknown) { captured.body = text === undefined ? undefined : JSON.parse(String(text)); },
  } as unknown as http.ServerResponse;
  return { res, captured };
}

async function call(method: string, p: string, body?: unknown): Promise<Captured> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage;
  req.method = method;
  const { res, captured } = fakeRes();
  const handled = await routes.handleMarketplaceRoutes(req, res, p);
  assert.equal(handled, true, `${method} ${p} must be handled by the marketplace module`);
  return captured;
}

describe("marketplace routes", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-mk-routes-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    routes = await import("../routes/marketplace.js");
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

  it("POST /api/agents/from-catalog creates the agent once and is idempotent", async () => {
    const first = await call("POST", "/api/agents/from-catalog", { catalogId: "bd-23-story-workshop" });
    assert.equal(first.status, 200);
    const data = first.body as { agent: { id: string; name: string }; already: boolean; install: { catalogId: string; agentId: string } };
    assert.equal(data.already, false);
    assert.equal(data.install.catalogId, "bd-23-story-workshop");
    assert.equal(data.install.agentId, data.agent.id);
    const created = agents.getAgent(data.agent.id);
    assert.ok(created);
    assert.ok(created.instructions.length > 0);

    const second = await call("POST", "/api/agents/from-catalog", { catalogId: "bd-23-story-workshop" });
    assert.equal(second.status, 200);
    const again = second.body as { agent: { id: string }; already: boolean };
    assert.equal(again.already, true);
    assert.equal(again.agent.id, data.agent.id);
  });

  it("rejects unknown catalog ids with 404 and empty bodies with 400", async () => {
    const missing = await call("POST", "/api/agents/from-catalog", { catalogId: "nope" });
    assert.equal(missing.status, 404);
    const empty = await call("POST", "/api/agents/from-catalog", {});
    assert.equal(empty.status, 400);
  });

  it("returns 405 for non-POST on the add endpoint", async () => {
    const cap = await call("GET", "/api/agents/from-catalog");
    assert.equal(cap.status, 405);
  });

  it("GET /api/marketplace/installs reports installs with the entry summary", async () => {
    const cap = await call("GET", "/api/marketplace/installs");
    assert.equal(cap.status, 200);
    const data = cap.body as { installs: Array<{ catalogId: string; agentId: string; entry: { name: string; source: string[]; tools: string[]; license: string } | null }>; count: number };
    assert.equal(data.count, data.installs.length);
    assert.ok(data.count >= 1);
    const withEntry = data.installs.find((i) => i.catalogId === "bd-23-story-workshop");
    assert.ok(withEntry?.entry);
    assert.ok(Array.isArray(withEntry.entry.source));
    assert.ok(Array.isArray(withEntry.entry.tools));
    assert.ok(withEntry.entry.license.length > 0);
  });

  it("GET /api/marketplace/catalog serves the bundled catalog", async () => {
    const cap = await call("GET", "/api/marketplace/catalog");
    assert.equal(cap.status, 200);
    const data = cap.body as { count: number; version: string };
    assert.equal(data.count, 819);
    assert.match(data.version, /^[a-f0-9]{16}$/);
  });

  it("leaves unrelated paths unhandled", async () => {
    const req = Readable.from([]) as unknown as http.IncomingMessage;
    req.method = "GET";
    const { res } = fakeRes();
    assert.equal(await routes.handleMarketplaceRoutes(req, res, "/api/agents"), false);
    assert.equal(await routes.handleMarketplaceRoutes(req, res, "/api/marketplace"), false);
  });
});
