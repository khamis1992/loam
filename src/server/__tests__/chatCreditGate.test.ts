/**
 * Credit gate on /api/chat.
 *
 * Enforcement is opt-in (`credits.enforce`): an exhausted balance gets a clean
 * 402 before the SSE stream opens, while a non-enforced install keeps running
 * on the local ledger.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

let server: import("node:http").Server;
let base = "";
let closeDb: () => void;
let credits: typeof import("../credits.js");

async function start(enforce: boolean): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-credit-gate-"));
  process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
  process.env.LOAM_ROOT = tmpDir;
  process.env.MANUS_LOCAL_SKILLS_DIR = path.join(tmpDir, "skills");
  process.env.LOAM_AUTH_DISABLED = "true";
  const workspace = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const config = path.join(tmpDir, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    workspace,
    credits: { enforce },
    memory: { enabled: false },
    screen: { enabled: false },
    selfImprove: { enabled: false },
    computerUse: { enabled: false },
    mcpServers: {},
  }), "utf8");
  process.env.LOAM_CONFIG = config;

  const { loadConfig } = await import("../../config.js");
  const { OllamaClient } = await import("../../ollama.js");
  const { startServer } = await import("../http.js");
  const cfg = loadConfig();
  cfg.server.host = "127.0.0.1";
  cfg.server.port = 0;
  server = await startServer({ cfg, ollama: new OllamaClient("http://127.0.0.1:1"), runTask: async () => ({ taskId: "t", text: "ok" }) });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
}

function chat(): Promise<Response> {
  return fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "hello", mode: "ask" }),
  });
}

describe("chat credit gate", () => {
  before(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-credit-seed-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    credits = await import("../credits.js");
    closeDb = (await import("../sqliteStore.js")).closeDb;
    await start(true);
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
  });

  it("lets an affordable run through", async () => {
    assert.ok(credits.getBalance() > 0);
    const res = await chat();
    assert.equal(res.status, 200);
    await res.text();
  });

  it("refuses with 402 once the balance is exhausted", async () => {
    credits.addCredits("usage", -credits.getBalance(), "drain-for-test");
    assert.equal(credits.getBalance(), 0);
    const res = await chat();
    assert.equal(res.status, 402);
    const body = (await res.json()) as { error: string; balance: number };
    assert.match(body.error, /insufficient credits/);
    assert.equal(body.balance, 0);
  });
});
