import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";
import { mergeAlwaysOnTools, ALWAYS_ON_TOOLS } from "../runTools.js";
import type { Tool, ToolContext } from "../../tools/registry.js";
import type { Config } from "../../config.js";

interface DeployToolsFactory {
  createDeployTools: (deps: { workspace?: string; preview?: unknown }) => Tool[];
}

const depWs: string = fs.mkdtempSync(path.join(os.tmpdir(), "loam-deploy-tool-"));
const dataDir: string = fs.mkdtempSync(path.join(os.tmpdir(), "loam-deploy-data-"));

let closeDb: () => void;
let taskId = "";

function fakeCtx(workspace: string): ToolContext {
  const cfg = { workspace } as unknown as Config;
  return {
    cfg,
    workspace,
    emit: () => {},
    taskId,
  };
}

describe("deploy_app tool exposure and behavior", () => {
  before(async () => {
    process.env.MANUS_LOCAL_DATA_DIR = dataDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    const db = await import("../db.js");
    db.loadDb();
    taskId = db.createTask("deploy test", undefined, null, null).id;
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try {
      fs.rmSync(depWs, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("deploy_app is part of the always-on run tool set", () => {
    assert.ok(ALWAYS_ON_TOOLS.includes("deploy_app"), "deploy_app in ALWAYS_ON_TOOLS");
    const merged = mergeAlwaysOnTools({
      resolvedAllow: [],
      registeredTools: ["deploy_app", "export_build"],
      disabledTools: [],
    });
    assert.ok(merged.includes("deploy_app"));
    assert.ok(merged.includes("export_build"));
    // per-agent denial still wins
    const denied = mergeAlwaysOnTools({
      resolvedAllow: [],
      registeredTools: ["deploy_app"],
      disabledTools: ["deploy_app"],
    });
    assert.ok(!denied.includes("deploy_app"));
  });

  it("runs export + local deploy over a real task workspace", async () => {
    const { requireTaskWorkspace } = await import("../taskWorkspace.js");
    const workspace = requireTaskWorkspace(taskId, depWs);
    fs.mkdirSync(path.join(workspace, "dist"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "dist", "index.html"), "<html><body>loam deploy</body></html>");
    fs.writeFileSync(path.join(workspace, "dist", "app.css"), "body{}");

    const { createDeployTools } = await import("../../tools/deploy.js") as DeployToolsFactory;
    const tool = createDeployTools({ workspace: depWs })[0]!;
    assert.equal(tool.name, "deploy_app");

    const result = await tool.run({ taskId, target: "local" }, fakeCtx(workspace));
    assert.ok(result.ok, result.content);
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    assert.equal(parsed.target, "local");
    assert.equal(typeof parsed.url, "string");
    assert.ok(fs.existsSync(parsed.zipPath as string), "export zip written");
    const exportTool = createDeployTools({ workspace: depWs })[1]!;
    assert.equal(exportTool.name, "export_build");
    const exported = JSON.parse((await exportTool.run({ taskId }, fakeCtx(workspace))).content) as Record<string, unknown>;
    assert.ok(exported.ok, "export_build ok");
    const exportedZip = exported.zipPath as string;
    assert.ok(/\.loam[\\/]exports[\\/]deploy-[\w-]+-\d{17}\.zip$/.test(exportedZip.replace(/\//g, "\\")), "stamp-named export zip");
    assert.ok(fs.existsSync(exportedZip));

    // local deploy wrote the dist content into .loam-deploy/<id>/...
    const depDir = parsed.distDir as string;
    assert.ok(fs.existsSync(path.join(depDir, "index.html")));
  });

  it("fails honestly when the task has no build output", async () => {
    const other = (await import("../db.js")).createTask("no build", undefined, null, null).id;
    const { createDeployTools } = await import("../../tools/deploy.js") as DeployToolsFactory;
    const tool = createDeployTools({ workspace: depWs })[0]!;
    const result = await tool.run({ taskId: other, target: "local" }, fakeCtx(depWs));
    assert.equal(result.ok, false);
    assert.match(result.content, /no build output found/);
  });

  it("cloud targets report the credentials they need", async () => {
    const { requireTaskWorkspace } = await import("../taskWorkspace.js");
    const workspace = requireTaskWorkspace(taskId, depWs);
    const { createDeployTools } = await import("../../tools/deploy.js") as DeployToolsFactory;
    const tool = createDeployTools({ workspace: depWs })[0]!;
    const prevVercel = process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TOKEN;
    try {
      const res = await tool.run({ taskId, target: "vercel" }, fakeCtx(workspace));
      const parsed = JSON.parse(res.content) as Record<string, unknown>;
      assert.equal(parsed.ok, false);
      assert.deepEqual(parsed.missingEnv, ["VERCEL_TOKEN"]);
    } finally {
      if (prevVercel !== undefined) process.env.VERCEL_TOKEN = prevVercel;
    }
  });
});
