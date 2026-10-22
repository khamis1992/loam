/**
 * Option #11 unit tests: share tokens, transcript sanitization and the HTTP
 * share routes. Revoked and unknown tokens must both answer 404, and the
 * sanitized transcript must never contain tool arguments (which can embed
 * env values or secrets). Uses the real store with an isolated data dir
 * (same pattern as scratchpad.test.ts).
 */
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { after, before, describe, it } from "node:test";

type Db = typeof import("../db.js");
type Shares = typeof import("../shares.js");
type Routes = typeof import("../routes/shares.js");

let tmpDir = "";
let closeDb: () => void;
let db: Db;
let shares: Shares;
let routes: Routes;
let server: http.Server;
let base: string;

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as import("node:net").AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

async function call(method: string, url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(base + url, { method });
  const body = await res.text();
  return { status: res.status, body };
}

describe("share tokens and routes (option #11)", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-shares-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    db = await import("../db.js");
    shares = await import("../shares.js");
    routes = await import("../routes/shares.js");
    db.loadDb();

    server = http.createServer((req, res) => {
      const p = new URL(req.url ?? "/", "http://x").pathname;
      void routes.handleShareRoutes(req, res, p).then((handled) => {
        if (!handled) { res.writeHead(404).end(); }
      });
    });
    base = await listen(server);
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { closeDb(); } catch { /* already closed */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a 32-byte urlsafe token and reuses the active share", () => {
    const created = db.createTask("hello world", "Hello");
    const share = shares.createShare(created.id)!;
    assert.ok(share);
    // 32 random bytes -> 43 base64url chars, urlsafe alphabet only.
    assert.equal(share.token.length, 43);
    assert.match(share.token, /^[A-Za-z0-9_-]+$/);
    assert.equal(shares.createShare(created.id)!.token, share.token, "active share is reused");
  });

  it("sanitizes the transcript: messages + artifact names, never tool args", () => {
    const created = db.createTask("make a report", "Report");
    db.appendMessage(created.id, "user", "make a report");
    db.appendStep(created.id, { at: new Date().toISOString(), type: "tool_call", data: { type: "tool_call", name: "file_write", args: { path: "out/report.pdf", apiKey: "SUPER-SECRET-VALUE", env: { TOKEN: "x" } } } });
    db.appendStep(created.id, { at: new Date().toISOString(), type: "tool_result", data: { type: "tool_result", name: "file_write", ok: true, summary: "wrote out/report.pdf" } });
    db.appendMessage(created.id, "assistant", "done, see report.pdf");
    const task = db.getTask(created.id)!;
    const transcript = shares.sanitizeTranscript(task);
    const raw = JSON.stringify(transcript);
    assert.equal(transcript.messages.length, 2);
    assert.deepEqual(transcript.messages.map((m) => m.role), ["user", "assistant"]);
    assert.ok(transcript.artifacts.includes("report.pdf"));
    assert.ok(!raw.includes("SUPER-SECRET-VALUE"), "args must not leak");
    assert.ok(!raw.includes('"args"'), "args key must not be present");
  });

  it("serves the transcript, then 404s after revocation", async () => {
    const created = db.createTask("share me", "Share me");
    db.appendMessage(created.id, "user", "share me");
    db.appendMessage(created.id, "assistant", "here you go");

    const createdRes = await call("POST", `/api/tasks/${created.id}/share`);
    assert.equal(createdRes.status, 200);
    const { token, url } = JSON.parse(createdRes.body) as { token: string; url: string };
    assert.equal(token.length, 43);
    assert.ok(url.includes(`/share/${token}`));

    const readRes = await call("GET", `/api/share/${token}`);
    assert.equal(readRes.status, 200);
    const payload = JSON.parse(readRes.body) as { transcript: { title: string; messages: unknown[] } };
    assert.equal(payload.transcript.title, "Share me");
    assert.equal(payload.transcript.messages.length, 2);

    const revokeRes = await call("DELETE", `/api/shares/${token}`);
    assert.equal(revokeRes.status, 200);

    // Revoked and unknown tokens are both plain 404.
    assert.equal((await call("GET", `/api/share/${token}`)).status, 404);
    assert.equal((await call("GET", `/api/share/${"A".repeat(43)}`)).status, 404);
    assert.equal((await call("DELETE", `/api/shares/${token}`)).status, 404);
    // Malformed tokens never touch the store.
    assert.equal((await call("GET", "/api/share/short")).status, 404);
  });

  it("404s share creation for unknown tasks and 404s reads of unknown tokens", async () => {
    assert.equal((await call("POST", "/api/tasks/task_does_not_exist/share")).status, 404);
    assert.equal((await call("GET", `/api/share/${"B".repeat(43)}`)).status, 404);
  });
});
