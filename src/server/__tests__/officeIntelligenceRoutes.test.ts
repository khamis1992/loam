import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import http from "node:http";
import type { Config } from "../../config.js";
import type { OllamaClient } from "../../ollama.js";
import type { OfficeIdentity } from "../../office/intelligence/authorization.js";
import type { ArtifactRef, OfficeRun } from "../../office/intelligence/contracts.js";
import type { SheetDoc } from "../workspace/sheetIO.js";

interface Captured { status: number; body: string }
type Handler = typeof import("../routes/officeIntelligence.js").handleOfficeIntelligenceRoutes;

let tmpDir = "";
let workspace = "";
let taskId = "";
let cfg: Config;
let closeDb: () => void;
let handler: Handler;
let writeSheetDoc: typeof import("../workspace/sheetIO.js").writeSheetDoc;
let readSheetDoc: typeof import("../workspace/sheetIO.js").readSheetDoc;

function fakeRes(): { res: http.ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: "" };
  const res = {
    writeHead(status: number) { captured.status = status; return res; },
    end(chunk?: unknown) { if (typeof chunk === "string") captured.body += chunk; return res; },
  };
  return { res: res as unknown as http.ServerResponse, captured };
}

async function call(method: string, target: string, body?: unknown, identity?: OfficeIdentity): Promise<Captured> {
  const req = new PassThrough() as PassThrough & { method: string; url: string; headers: Record<string, string> };
  req.method = method;
  req.url = target;
  req.headers = { host: "127.0.0.1" };
  const { res, captured } = fakeRes();
  const pending = handler(req as unknown as http.IncomingMessage, res, target.split("?")[0]!, {
    workspace,
    cfg,
    ollama: {} as OllamaClient,
    ...(identity ? { identity } : {}),
  });
  if (body !== undefined) req.write(JSON.stringify(body));
  req.end();
  await pending;
  return captured;
}

function sheet(task: string): SheetDoc {
  return {
    taskId: task,
    path: "finance.xlsx",
    name: "finance.xlsx",
    sheets: [{ name: "Sheet1", cells: [["Item", "Date"], [" A ", "01/02/2024"], ["B", "02/02/2024"]], styles: {}, columnWidths: [], rowHeights: [], merges: [], hiddenRows: [], hiddenColumns: [] }],
    notes: [],
  };
}

describe("Office intelligence HTTP journey", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-office-ai-"));
    workspace = path.join(tmpDir, "task-workspace");
    fs.mkdirSync(workspace, { recursive: true });
    process.env.MANUS_LOCAL_DATA_DIR = path.join(tmpDir, "data");
    process.env.LOAM_ROOT = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    const db = await import("../db.js");
    taskId = db.createTask("Office intelligence test").id;
    db.setTaskWorkspace(taskId, workspace);
    cfg = (await import("../../config.js")).loadConfig();
    const sheetIO = await import("../workspace/sheetIO.js");
    writeSheetDoc = sheetIO.writeSheetDoc;
    readSheetDoc = sheetIO.readSheetDoc;
    await writeSheetDoc(path.join(workspace, "finance.xlsx"), sheet(taskId));
    handler = (await import("../routes/officeIntelligence.js")).handleOfficeIntelligenceRoutes;
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    delete process.env.LOAM_ROOT;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("describes, analyzes, previews, applies and verifies an XLSX change", async () => {
    const described = await call("POST", "/api/office/intelligence/artifacts/describe", { taskId, path: "finance.xlsx", kind: "spreadsheet", scope: { tenantId: "local" } });
    assert.equal(described.status, 200, described.body);
    const artifact = (JSON.parse(described.body) as { artifact: ArtifactRef }).artifact;
    assert.equal(artifact.revision, 0);
    assert.match(artifact.contentHash, /^[a-f0-9]{64}$/);

    const started = await call("POST", "/api/office/intelligence/runs", { capability: "sheet-cleaning", artifact, instruction: "", scope: { tenantId: "local" } });
    assert.equal(started.status, 202, started.body);
    let run = (JSON.parse(started.body) as { run: OfficeRun }).run;
    for (let attempt = 0; attempt < 100 && run.status !== "succeeded" && run.status !== "failed"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const response = await call("GET", `/api/office/intelligence/runs/${run.id}`);
      run = (JSON.parse(response.body) as { run: OfficeRun }).run;
    }
    assert.equal(run.status, "succeeded", run.error);
    assert.ok(run.result?.changeSet);
    assert.ok(run.result.changeSet.preview.length >= 3);

    const applied = await call("POST", `/api/office/intelligence/runs/${run.id}/apply`, {});
    assert.equal(applied.status, 200, applied.body);
    const saved = await readSheetDoc(path.join(workspace, "finance.xlsx"), { taskId, path: "finance.xlsx", name: "finance.xlsx" });
    assert.equal(saved.sheets[0]?.cells[1]?.[0], "A");
    assert.equal(saved.sheets[0]?.cells[1]?.[1], "2024-02-01");
  });

  it("serves the artifact and run APIs over a real HTTP connection", async () => {
    const server = http.createServer((req, res) => {
      const target = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      void handler(req, res, target, { workspace, cfg, ollama: {} as OllamaClient });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server address unavailable");
      const base = `http://127.0.0.1:${address.port}`;
      const described = await fetch(`${base}/api/office/intelligence/artifacts/describe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId, path: "finance.xlsx", kind: "spreadsheet", scope: { tenantId: "local" } }),
      });
      assert.equal(described.status, 200);
      const artifact = (await described.json() as { artifact: ArtifactRef }).artifact;
      const started = await fetch(`${base}/api/office/intelligence/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability: "sheet-analysis", artifact, instruction: "", scope: { tenantId: "local" } }),
      });
      assert.equal(started.status, 202);
      const run = (await started.json() as { run: OfficeRun }).run;
      const fetched = await fetch(`${base}/api/office/intelligence/runs/${run.id}`);
      assert.equal(fetched.status, 200);
      assert.equal((await fetched.json() as { run: OfficeRun }).run.id, run.id);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("denies AI access to clients and access through ethical walls", async () => {
    const described = await call("POST", "/api/office/intelligence/artifacts/describe", { taskId, path: "finance.xlsx", kind: "spreadsheet", scope: { tenantId: "local" } });
    const artifact = (JSON.parse(described.body) as { artifact: ArtifactRef }).artifact;
    const client: OfficeIdentity = { id: "client-1", tenantIds: ["local"], roles: ["client"] };
    const denied = await call("POST", "/api/office/intelligence/runs", { capability: "sheet-analysis", artifact, instruction: "", scope: { tenantId: "local" } }, client);
    assert.equal(denied.status, 403);
    const walled: OfficeIdentity = { id: "partner-1", tenantIds: ["local"], roles: ["partner"], ethicalWallMatterIds: ["matter-secret"] };
    const blocked = await call("POST", "/api/office/intelligence/runs", { capability: "sheet-analysis", artifact, instruction: "", scope: { tenantId: "local", matterId: "matter-secret" } }, walled);
    assert.equal(blocked.status, 403);
  });
});
