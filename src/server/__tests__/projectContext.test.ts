import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { Readable } from "node:stream";
import { describe, it, before } from "node:test";

let tmpDir = "";

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
  const { handleProjectContextRoutes } = await import("../routes/projectContext.js");
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage;
  req.method = method;
  const { res, captured } = fakeRes();
  const handled = await handleProjectContextRoutes(req, res, p);
  assert.equal(handled, true, `${method} ${p} must be handled by the module`);
  return captured;
}

describe("projectContext routes", () => {
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-ctx-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    // `projectContext.js` calls `loadConfig()` at module load, which mkdirs
    // `workspace/` and `workspace/.screenshots/`; LOAM_ROOT keeps them in temp.
    process.env.LOAM_ROOT = tmpDir;
  });

  it("GET /api/model-tiers lists all four tiers and never returns a key", async () => {
    const cap = await call("GET", "/api/model-tiers");
    assert.equal(cap.status, 200);
    const data = cap.body as { tiers: Array<{ id: string; model: string }>; flex: Record<string, unknown> };
    assert.deepEqual(data.tiers.map((t) => t.id), ["max", "standard", "lite", "flex"]);
    assert.equal(typeof data.flex.hasKey, "boolean");
    assert.ok(!("key" in data.flex), "flex projection must not carry a key field");
  });

  it("PUT /api/model-tiers/flex stores config; response has no key material", async () => {
    const cap = await call("PUT", "/api/model-tiers/flex", { key: "sk-route-test", baseUrl: "https://api.example.com/v1", model: "their-llm" });
    assert.equal(cap.status, 200);
    const data = cap.body as { ok: boolean; flex: { hasKey: boolean; baseUrl: string; model: string } };
    assert.ok(data.ok);
    assert.equal(data.flex.hasKey, true);
    assert.equal(data.flex.baseUrl, "https://api.example.com/v1");
    assert.ok(!JSON.stringify(cap.body).includes("sk-route-test"));
  });

  it("project folder + git + unknown project", async () => {
    const { createProject, updateProject } = await import("../db.js");
    const project = createProject("ctx test");
    const noGit = await call("GET", `/api/projects/${project.id}/git`);
    assert.equal(noGit.status, 200);
    assert.equal((noGit.body as { isGit: boolean }).isGit, false);

    const badFolder = await call("PUT", `/api/projects/${project.id}/folder`, { path: path.join(tmpDir, "does-not-exist") });
    assert.equal(badFolder.status, 400);

    fs.mkdirSync(path.join(tmpDir, "repo"), { recursive: true });
    const setOk = await call("PUT", `/api/projects/${project.id}/folder`, { path: path.join(tmpDir, "repo") });
    assert.equal(setOk.status, 200);
    assert.equal((setOk.body as { project: { folder?: string } }).project.folder, path.join(tmpDir, "repo"));

    const missing = await call("GET", "/api/projects/proj_nope/git");
    assert.equal(missing.status, 404);
    // db updateProject accepts folder too
    const updated = updateProject(project.id, { folder: "" });
    assert.ok(updated && !("folder" in updated));
  });

  it("PATCH /api/schedules/:id edits prompt and enabled state", async () => {
    const { addSchedule, getSchedule } = await import("../db.js");
    const s = addSchedule("original", 60);
    const cap = await call("PATCH", `/api/schedules/${s.id}`, { prompt: "updated", enabled: false });
    assert.equal(cap.status, 200);
    const stored = getSchedule(s.id);
    assert.ok(stored);
    assert.equal(stored.prompt, "updated");
    assert.equal(stored.enabled, false);
    const missing = await call("PATCH", "/api/schedules/sched_nope", { enabled: true });
    assert.equal(missing.status, 404);
  });

  it("leaves unrelated paths unhandled", async () => {
    const { handleProjectContextRoutes } = await import("../routes/projectContext.js");
    const req = Readable.from([]) as unknown as http.IncomingMessage;
    req.method = "GET";
    const { res } = fakeRes();
    assert.equal(await handleProjectContextRoutes(req, res, "/api/agents"), false);
    assert.equal(await handleProjectContextRoutes(req, res, "/api/projects"), false);
  });
});
