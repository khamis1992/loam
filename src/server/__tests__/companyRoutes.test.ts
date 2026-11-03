import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-company-routes-"));
process.env.MANUS_LOCAL_DATA_DIR = tmp;

const { createAppProject } = await import("../../appbuilder/projects.js");
const { handleCompanyRoutes } = await import("../routes/company.js");
const { testConfig } = await import("../../orchestration/__tests__/helpers.js");

function req(method: string, body?: unknown): http.IncomingMessage {
  const request = new Readable({ read() {} }) as unknown as http.IncomingMessage;
  request.method = method;
  request.headers = {};
  process.nextTick(() => {
    if (body !== undefined) request.emit("data", Buffer.from(JSON.stringify(body)));
    request.emit("end");
  });
  return request;
}

function res(): { response: http.ServerResponse; done: Promise<{ status: number; body: Buffer }> } {
  const writable = new Writable({ write(_chunk, _encoding, callback) { callback(); } }) as unknown as http.ServerResponse;
  const chunks: Buffer[] = [];
  let status = 0;
  writable.writeHead = ((code: number) => { status = code; return writable; }) as typeof writable.writeHead;
  writable.setHeader = (() => writable) as typeof writable.setHeader;
  writable.end = ((data?: string | Buffer) => {
    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    writable.emit("close");
  }) as typeof writable.end;
  return { response: writable, done: new Promise((resolve) => writable.on("close", () => resolve({ status, body: Buffer.concat(chunks) }))) };
}

test("company HTTP: create, approve, verify and export", async () => {
  const project = createAppProject({ title: "http-company", baseWorkspace: tmp });
  const deps = {
    cfg: { ...testConfig(), workspace: project.workspaceDir },
    ollama: {} as never,
    runTask: async () => {
      const root = path.join(project.workspaceDir, "app");
      fs.mkdirSync(path.join(root, "src", "pages"), { recursive: true });
      fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "pages", "Index.tsx"), "export default function Home() { return <main>Product</main>; }");
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { check: "node -e \"\"", lint: "node -e \"\"", typecheck: "node -e \"\"", build: "node -e \"\"" } }));
      fs.writeFileSync(path.join(root, "scripts", "link-deps.mjs"), "export {};\n");
      return { taskId: project.taskId, text: "built" };
    },
    devServer: {
      ensure: async () => "http://127.0.0.1:15173",
      stop: () => undefined,
    } as never,
  };
  const readBody = async () => ({ idea: "أنشئ لوحة تحليلات للمبيعات مع تصفية ورسوم", autoStart: false });
  const created = res();
  assert.equal(await handleCompanyRoutes(req("POST"), created.response, project, ["company", "runs"], readBody, deps), true);
  const started = JSON.parse((await created.done).body.toString()) as { run: { id: string; stage: string } };
  const runId = started.run.id;
  const approved = res();
  await handleCompanyRoutes(req("POST"), approved.response, project, ["company", "runs", runId, "approve"], readBody, deps);
  assert.equal((await approved.done).status, 202, (await approved.done).body.toString());

  let run: { stage: string; versionNumber: number | null } = { stage: "", versionNumber: null };
  for (let i = 0; i < 1_000; i++) {
    const current = res();
    await handleCompanyRoutes(req("GET"), current.response, project, ["company", "runs", runId], readBody, deps);
    run = JSON.parse((await current.done).body.toString()).run;
    if (["done", "failed", "cancelled"].includes(run.stage)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(run.stage, "done", JSON.stringify(run));
  assert.equal(run.versionNumber, 1);
  const exported = res();
  await handleCompanyRoutes(req("GET"), exported.response, project, ["company", "runs", runId, "export"], readBody, deps);
  assert.equal((await exported.done).status, 200);
  assert.equal((await exported.done).body.subarray(0, 2).toString(), "PK");
});
