import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handleCollabRoutes } from "../collabDoc.js";
import { saveDocTrack } from "../../workspace/docTrackIO.js";
import { requireTaskWorkspace } from "../../taskWorkspace.js";
import { createTask, setTaskWorkspace } from "../../db.js";

// Isolate the task store (lazily opened sqlite) in a temp data dir BEFORE the
// first db call; each node:test file runs in its own process.
process.env.MANUS_LOCAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "collab-db-"));

/** Seed a tracked document with one paragraph so ops have a target. */
function seedDoc(): void {
  saveDocTrack(taskWorkspace, DOC_REL, {
    paragraphs: [{ id: "p1", runs: [{ id: "b1", type: "base", text: "نص الافتتاح" }] }],
    authors: {},
  });
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "collab-ws-"));
const TASK = "task_collab1";
const DOC_REL = "docs/brief.docx";
// Collab targets live inside a registered task's workspace.
createTask("collab test brief", "collab", null, null, TASK);
const taskWorkspace = requireTaskWorkspace(TASK, workspace);
setTaskWorkspace(TASK, taskWorkspace);
fs.mkdirSync(path.join(taskWorkspace, "docs"), { recursive: true });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const handled = await handleCollabRoutes(req, res, url.pathname, { workspace });
  if (!handled) {
    res.writeHead(404).end();
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => { server.close(); fs.rmSync(workspace, { recursive: true, force: true }); });

async function post(pathname: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("collab doc routes (د3)", () => {
  it("joins, applies an op, persists the sidecar, and leaves", async () => {
    seedDoc();
    const join = await post("/api/collab/join", { taskId: TASK, path: DOC_REL, clientId: "c1", name: "أحمد" });
    assert.equal(join.status, 200, JSON.stringify(join.json));
    assert.equal((join.json.members as unknown[]).length, 1);

    const op = await post("/api/collab/op", {
      taskId: TASK, path: DOC_REL, clientId: "c1",
      op: { kind: "insert", paragraphId: "p1", offset: 0, text: "تمهيد: " }, baseSeq: 0,
    });
    assert.equal(op.status, 200);
    assert.equal(op.json.ok, true);

    // Sidecar persisted inside the TASK workspace (docTrackIO keying).
    const trackDir = path.join(taskWorkspace, ".loam", "track");
    assert.equal(fs.existsSync(trackDir), true);
    const files = fs.readdirSync(trackDir);
    assert.equal(files.length >= 1, true);
    const saved = JSON.parse(fs.readFileSync(path.join(trackDir, files[0]!), "utf8"));
    assert.equal(JSON.stringify(saved).includes("تمهيد"), true);

    const left = await post("/api/collab/leave", { taskId: TASK, path: DOC_REL, clientId: "c1" });
    assert.equal(left.status, 200);
  });

  it("rejects a stale op with 409 and the canonical paragraph", async () => {
    // Own document so the room state from the previous test cannot leak.
    const STALE_REL = "docs/stale.docx";
    saveDocTrack(taskWorkspace, STALE_REL, {
      paragraphs: [{ id: "p1", runs: [{ id: "b1", type: "base", text: "نص" }] }],
      authors: {},
    });
    await post("/api/collab/join", { taskId: TASK, path: STALE_REL, clientId: "c1", name: "أحمد" });
    await post("/api/collab/join", { taskId: TASK, path: STALE_REL, clientId: "c2", name: "سارة" });
    const first = await post("/api/collab/op", {
      taskId: TASK, path: STALE_REL, clientId: "c1",
      op: { kind: "insert", paragraphId: "p1", offset: 0, text: "A" }, baseSeq: 0,
    });
    assert.equal(first.status, 200);
    const stale = await post("/api/collab/op", {
      taskId: TASK, path: STALE_REL, clientId: "c2",
      op: { kind: "insert", paragraphId: "p1", offset: 0, text: "B" }, baseSeq: 0,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error, "stale");
    assert.ok(stale.json.paragraph, "canonical paragraph returned");
  });

  it("rejects traversal and unknown paths", async () => {
    const bad = await post("/api/collab/join", { taskId: TASK, path: "../outside.docx", clientId: "c1", name: "x" });
    assert.equal(bad.status, 400);
    const missing = await post("/api/collab/op", {
      taskId: TASK, path: DOC_REL, clientId: "ghost",
      op: { kind: "insert", paragraphId: "p1", offset: 0, text: "x" }, baseSeq: 0,
    });
    assert.equal(missing.status, 400);
  });

  it("streams patches and presence over SSE", async () => {
    seedDoc();
    const joinA = await post("/api/collab/join", { taskId: TASK, path: DOC_REL, clientId: "cA", name: "أحمد" });
    const seqAfterJoin = Number(joinA.json.seq ?? 0);
    const streamRes = await fetch(
      `${base}/api/collab/stream?taskId=${encodeURIComponent(TASK)}&path=${encodeURIComponent(DOC_REL)}&clientId=cA&afterSeq=${seqAfterJoin}`,
    );
    assert.equal(streamRes.status, 200);
    assert.equal(streamRes.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const reader = streamRes.body!.getReader();
    const seen: string[] = [];
    const readPromise = (async () => {
      const decoder = new TextDecoder();
      while (seen.filter((line) => line.includes("event: patch")).length === 0) {
        const chunk = await reader.read();
        if (chunk.done) break;
        seen.push(decoder.decode(chunk.value));
      }
    })();
    // Give the server a beat to register the stream, then apply an op.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await post("/api/collab/op", {
      taskId: TASK, path: DOC_REL, clientId: "cA",
      op: { kind: "insert", paragraphId: "p1", offset: 0, text: "حي " }, baseSeq: seqAfterJoin,
    });
    await Promise.race([readPromise, new Promise((resolve) => setTimeout(resolve, 3000))]);
    reader.cancel().catch(() => undefined);
    const all = seen.join("");
    assert.equal(all.includes("event: patch"), true);
    assert.equal(all.includes("حي"), true);
  });
});
