// W4b tests — Stripe BYOK env passthrough (vault + user env, through the
// DevServerManager spawn seam) and the SQLite pull/push sync overlay.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { AppProject } from "../types.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-w4b-"));
process.env.MANUS_LOCAL_DATA_DIR = tmp;
delete process.env.STRIPE_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;

const { ensureAppBuilderSchema } = await import("../store.js");
const { stripeEnvFor, stripeStatus, setAppStripe, aiEnvFor, APP_VAULT_SCOPE, STRIPE_KEY_NAME, STRIPE_WEBHOOK_NAME } = await import("../localCloud.js");
const { deleteSecret, setSecret } = await import("../../server/secretsVault.js");
const { scrubEnv } = await import("../../subagent/env.js");
const { redactSecrets } = await import("../redact.js");
const { createLoamSyncHandler, writeSyncOverlay, syncOverlaySource, SYNC_MAX_BYTES, SYNC_PULL_PATH, SYNC_PUSH_PATH } = await import("../appSync.js");
const { DevServerManager } = await import("../devServer.js");

ensureAppBuilderSchema();

function fakeProject(id: string, workspaceDir: string): AppProject {
  return {
    id, taskId: "task_x", title: "byok", description: "", templateId: "web-app", features: ["fullstack"],
    workspaceDir, appDir: "app", defaultFlavor: "quick", status: "idle", activeVersion: null,
    settings: { defaultTier: "auto", raceBranches: 2, verifyTier: "fast", devServerPort: null },
    remixOfProjectId: null, remixOfVersion: null, depsMode: "shared",
    ai: { baseUrl: null, model: null, dailyTokenCap: null }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

// ---------- Stripe BYOK: resolution, status, redaction ----------

const SK = `sk_test_${"a".repeat(30)}`;
const WH = `whsec_${"b".repeat(30)}`;

test("stripe: no vault key and no user env → empty env, source none", () => {
  deleteSecret(APP_VAULT_SCOPE, STRIPE_KEY_NAME);
  deleteSecret(APP_VAULT_SCOPE, STRIPE_WEBHOOK_NAME);
  assert.deepEqual(stripeEnvFor(), {});
  assert.equal(stripeStatus().source, "none");
  assert.equal(stripeStatus().hasKey, false);
});

test("stripe: vault key wins, value never returns from setters/status", () => {
  const r = setAppStripe({ key: SK, webhookSecret: WH });
  assert.ok("status" in r, "valid input stores");
  assert.equal(r.status.source, "vault");
  assert.equal(r.status.hasKey, true);
  assert.equal(r.status.hasWebhookSecret, true);
  assert.ok(!JSON.stringify(r).includes(SK), "the setter result must never echo the key");
  assert.ok(!JSON.stringify(stripeStatus()).includes(SK));
  const env = stripeEnvFor();
  assert.equal(env.STRIPE_KEY, SK);
  assert.equal(env.STRIPE_WEBHOOK_SECRET, WH);
});

test("stripe: invalid values rejected, empty string clears", () => {
  assert.equal((setAppStripe({ key: "short" }) as { error: string }).error, "stripe_key_invalid");
  assert.equal((setAppStripe({ webhookSecret: "has space inside0" }) as { error: string }).error, "stripe_webhook_invalid");
  const cleared = setAppStripe({ key: "", webhookSecret: "" });
  assert.ok("status" in cleared);
  assert.equal(cleared.status.hasKey, false);
  assert.equal(cleared.status.hasWebhookSecret, false);
});

test("stripe: the user's own process env is the fallback source (BYOK)", () => {
  process.env.STRIPE_KEY = `sk_live_${"c".repeat(30)}`;
  const env = stripeEnvFor();
  assert.equal(env.STRIPE_KEY, process.env.STRIPE_KEY);
  assert.equal(stripeStatus().source, "environment");
  assert.ok(!("STRIPE_WEBHOOK_SECRET" in env));
  delete process.env.STRIPE_KEY;
});

test("stripe: scrubEnv drops STRIPE_* from inherited env, so the aiEnv spread is the only path", () => {
  process.env.STRIPE_KEY = SK;
  const scrubbed = scrubEnv(process.env);
  assert.ok(!("STRIPE_KEY" in scrubbed), "the inherited spawn env must never carry the key");
  const spawnEnv = { ...scrubbed, ...stripeEnvFor() };
  assert.equal(spawnEnv.STRIPE_KEY, SK);
  delete process.env.STRIPE_KEY;
});

test("stripe: aiEnvFor stays AI-only; the Stripe env joins at the same aiEnv hook (runtime.ts)", () => {
  const project = fakeProject("app_byokcompose1", tmp);
  assert.deepEqual(aiEnvFor(project), {}, "no AI provider configured → no AI env");
  const composed = { ...aiEnvFor(project), ...stripeEnvFor() };
  assert.deepEqual(composed, stripeEnvFor(), "the spawn composition is exactly the Stripe env here");
});

test("stripe: redactSecrets catches Stripe key formats", () => {
  const dirty = `key=${SK} wh=${WH} live=sk_live_${"d".repeat(30)} pk=pk_live_${"e".repeat(30)}`;
  const out = redactSecrets(dirty);
  assert.ok(!out.includes(SK) && !out.includes(WH));
  assert.ok(!out.includes("sk_live_") && !out.includes("pk_live_"));
  assert.ok(out.includes("[redacted]"));
});

// ---------- Stripe + AI env reach the spawned app server (real spawn seam) ----------

function stubApp(workspaceDir: string, tag: string): string {
  const appDir = path.join(workspaceDir, "app");
  fs.mkdirSync(path.join(appDir, "server"), { recursive: true });
  fs.mkdirSync(path.join(appDir, "data"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "stub", private: true, scripts: { dev: "node dev-stub.mjs" } }), "utf8");
  fs.writeFileSync(path.join(appDir, "dev-stub.mjs"), [
    "import http from 'node:http';",
    "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
    "http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); }).listen(port, '127.0.0.1');",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(appDir, "server", "index.mjs"), [
    "import fs from 'node:fs';",
    `const out = JSON.stringify({ tag: ${JSON.stringify(tag)}, STRIPE_KEY: process.env.STRIPE_KEY ?? null, STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ?? null, AI_API_KEY: process.env.AI_API_KEY ?? null, LOAM_DB_PATH: process.env.LOAM_DB_PATH ?? null });`,
    `fs.writeFileSync(${JSON.stringify(path.join(tmp, `spawn-env-${tag}.json`))}, out);`,
  ].join("\n"), "utf8");
  return appDir;
}

async function waitForFile(file: string, ms = 8_000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`spawn env file never appeared: ${file}`);
}

test("spawned app server env: carries the vault Stripe key when present, omits it when absent", async () => {
  const ws1 = fs.mkdtempSync(path.join(tmp, "ws1-"));
  const p1 = fakeProject("app_byokspawn001", ws1);
  stubApp(ws1, "present");
  setSecret(APP_VAULT_SCOPE, STRIPE_KEY_NAME, SK);
  setSecret(APP_VAULT_SCOPE, STRIPE_WEBHOOK_NAME, WH);
  const manager = new DevServerManager({
    onStatus: () => undefined,
    aiEnv: (project) => ({ ...aiEnvFor(project), ...stripeEnvFor() }), // same composition as buildAppRuntime
  });
  try {
    await manager.ensure(p1);
    const env = JSON.parse(await waitForFile(path.join(tmp, "spawn-env-present.json"))) as Record<string, string | null>;
    assert.equal(env.STRIPE_KEY, SK, "the spawned app server must see the vault key");
    assert.equal(env.STRIPE_WEBHOOK_SECRET, WH);
    assert.ok(String(env.LOAM_DB_PATH).endsWith(path.join("app", "data", "app.sqlite")));
    assert.equal(env.AI_API_KEY, null, "no AI provider configured → no AI env");
    // the fullstack spawn also refreshed the sync overlay
    const overlay = path.join(ws1, "app", "server", "loam-sync.mjs");
    assert.ok(fs.existsSync(overlay), "writeSyncOverlay ran before the api spawn");
    assert.equal(fs.readFileSync(overlay, "utf8"), syncOverlaySource());
  } finally {
    manager.stop(p1.id);
  }

  // absent: cleared vault and no user env → nothing reaches the spawn
  const ws2 = fs.mkdtempSync(path.join(tmp, "ws2-"));
  const p2 = fakeProject("app_byokspawn002", ws2);
  stubApp(ws2, "absent");
  deleteSecret(APP_VAULT_SCOPE, STRIPE_KEY_NAME);
  deleteSecret(APP_VAULT_SCOPE, STRIPE_WEBHOOK_NAME);
  const manager2 = new DevServerManager({ onStatus: () => undefined, aiEnv: (project) => ({ ...aiEnvFor(project), ...stripeEnvFor() }) });
  try {
    await manager2.ensure(p2);
    const env = JSON.parse(await waitForFile(path.join(tmp, "spawn-env-absent.json"))) as Record<string, string | null>;
    assert.equal(env.STRIPE_KEY, null);
    assert.equal(env.STRIPE_WEBHOOK_SECRET, null);
  } finally {
    manager2.stop(p2.id);
  }
});

// ---------- SQLite sync overlay: pull/push through a real local server ----------

function makeSqlite(dir: string, name = "app.sqlite"): string {
  const file = path.join(dir, name);
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  db.prepare("INSERT INTO t (v) VALUES (?)").run("مرحبا");
  db.close();
  return file;
}

function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => boolean): Promise<{ server: http.Server; url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (!handler(req, res)) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"not_found"}'); }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

test("sync: pull/push round-trip on the TS handler, atomic rename, no tmp left", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "sync-"));
  const db = makeSqlite(dir);
  const original = fs.readFileSync(db);
  const h = await serve(createLoamSyncHandler({ dbPath: db }));
  try {
    // pull returns the exact bytes, streamed
    const pull = await fetch(`${h.url}${SYNC_PULL_PATH}`);
    assert.equal(pull.status, 200);
    assert.equal(pull.headers.get("x-loam-sync"), "pull");
    assert.equal(Number(pull.headers.get("content-length")), original.length);
    assert.deepEqual(Buffer.from(await pull.arrayBuffer()), original);

    // push replaces the file atomically; .push-tmp never survives
    const replacement = Buffer.concat([original, Buffer.from("--pushed")]);
    const push = await fetch(`${h.url}${SYNC_PUSH_PATH}`, { method: "POST", body: replacement });
    assert.equal(push.status, 200);
    assert.deepEqual(await push.json(), { ok: true, bytes: replacement.length });
    assert.ok(!fs.existsSync(`${db}.push-tmp`), "atomic rename leaves no tmp file");
    assert.deepEqual(fs.readFileSync(db), replacement);
    const pull2 = await fetch(`${h.url}${SYNC_PULL_PATH}`);
    assert.deepEqual(Buffer.from(await pull2.arrayBuffer()), replacement);

    // the pushed file is still a working sqlite database
    const ro = new DatabaseSync(db, { readOnly: true });
    assert.equal((ro.prepare("SELECT COUNT(*) c FROM t").get() as { c: number }).c, 1);
    ro.close();

    // empty push refuses; wrong method refuses; other paths are not handled
    assert.equal((await fetch(`${h.url}${SYNC_PUSH_PATH}`, { method: "POST", body: Buffer.alloc(0) })).status, 400);
    assert.equal((await fetch(`${h.url}${SYNC_PULL_PATH}`, { method: "PUT" })).status, 405);
    assert.equal((await fetch(`${h.url}/api/other`)).status, 404);
  } finally {
    await h.close();
  }
});

test("sync: caps — pull 413 over maxBytes, push 413 over maxBytes; pull 404 when no db", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "sync-cap-"));
  const db = makeSqlite(dir);
  const h = await serve(createLoamSyncHandler({ dbPath: db, maxBytes: 16 }));
  try {
    const pull = await fetch(`${h.url}${SYNC_PULL_PATH}`);
    assert.equal(pull.status, 413);
    assert.equal((await pull.json() as { maxBytes: number }).maxBytes, 16);

    const push = await fetch(`${h.url}${SYNC_PUSH_PATH}`, { method: "POST", body: Buffer.alloc(64, 1) });
    assert.equal(push.status, 413);
    assert.deepEqual(fs.readFileSync(db).subarray(0, 15), Buffer.from("SQLite format 3"), "the over-cap push never touched the file");
  } finally {
    await h.close();
  }
  // missing file
  const h2 = await serve(createLoamSyncHandler({ dbPath: path.join(dir, "missing.sqlite") }));
  try {
    assert.equal((await fetch(`${h2.url}${SYNC_PULL_PATH}`)).status, 404);
    // push still creates the file atomically (mkdir + tmp + rename)
    const push = await fetch(`${h2.url}${SYNC_PUSH_PATH}`, { method: "POST", body: Buffer.from("SQLite format 3\0pushed") });
    assert.equal(push.status, 200);
    assert.ok(fs.existsSync(path.join(dir, "missing.sqlite")));
  } finally {
    await h2.close();
  }
  assert.equal(SYNC_MAX_BYTES, 25 * 1024 * 1024);
});

test("sync: the shipped overlay (server/loam-sync.mjs) behaves like the TS handler", async () => {
  const appDir = fs.mkdtempSync(path.join(tmp, "overlay-"));
  const overlayPath = writeSyncOverlay(appDir);
  writeSyncOverlay(appDir); // idempotent
  assert.equal(overlayPath, path.join(appDir, "server", "loam-sync.mjs"));
  const mod = await import(pathToFileURL(overlayPath).href) as {
    handleLoamSync: (req: http.IncomingMessage, res: http.ServerResponse, opts?: { dbPath?: string; maxBytes?: number }) => boolean;
  };
  const dir = fs.mkdtempSync(path.join(tmp, "overlay-db-"));
  const db = makeSqlite(dir);
  const original = fs.readFileSync(db);
  const h = await serve((req, res) => mod.handleLoamSync(req, res, { dbPath: db }));
  try {
    const pull = await fetch(`${h.url}${SYNC_PULL_PATH}`);
    assert.equal(pull.status, 200);
    assert.deepEqual(Buffer.from(await pull.arrayBuffer()), original);
    const replacement = Buffer.concat([original, Buffer.from("--overlay")]);
    const push = await fetch(`${h.url}${SYNC_PUSH_PATH}`, { method: "POST", body: replacement });
    assert.equal(push.status, 200);
    assert.deepEqual(fs.readFileSync(db), replacement);
    assert.ok(!fs.existsSync(`${db}.push-tmp`));
    assert.equal((await fetch(`${h.url}${SYNC_PUSH_PATH}`, { method: "POST", body: Buffer.alloc(0) })).status, 400);
    assert.equal((await fetch(`${h.url}${SYNC_PULL_PATH}`, { method: "PUT" })).status, 405);
  } finally {
    await h.close();
  }
  // the overlay also honors LOAM_DB_PATH when no explicit dbPath is passed
  process.env.LOAM_DB_PATH = db;
  try {
    const h2 = await serve((req, res) => mod.handleLoamSync(req, res));
    try {
      const pull = await fetch(`${h2.url}${SYNC_PULL_PATH}`);
      assert.equal(pull.status, 200);
    } finally {
      await h2.close();
    }
  } finally {
    delete process.env.LOAM_DB_PATH;
  }
});
