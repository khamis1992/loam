import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AppProject, VerifyReport } from "../types.js";
import type { VerifyDeps } from "../verifyLoop.js";
import type { ShotResult } from "../../preview/shot.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-company-"));
process.env.MANUS_LOCAL_DATA_DIR = tmp;

const { analyzeProductIdea } = await import("../company/brief.js");
const { CompanyEngine } = await import("../company/engine.js");
const { createAppProject, getAppProject } = await import("../projects.js");
const { versionRows } = await import("../company/store.js");

function project(title: string): AppProject {
  return createAppProject({ title, baseWorkspace: tmp });
}

function verifyDeps(fail = false): VerifyDeps {
  const shots = {
    capture: async (): Promise<ShotResult> => ({ ok: true, url: "http://127.0.0.1", dir: "", shots: [], errors: [], warnings: [], elapsedMs: 1 }),
  };
  return {
    ensureDevServer: async () => "http://127.0.0.1:15173",
    reviewVisual: async () => ({ pass: true, problems: [], parsed: true }),
    runContract: async () => ({ pass: true, reason: "" }),
    shots: shots as unknown as VerifyDeps["shots"],
  };
}

function writeApp(project: AppProject, failBuild = false): void {
  const root = path.join(project.workspaceDir, "app");
  fs.mkdirSync(path.join(root, "src", "pages"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "pages", "Index.tsx"), failBuild ? "LOAM_PLACEHOLDER_PAGE" : "export default function Home() { return <main>Real product</main>; }");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    scripts: {
      check: "node -e \"\"", lint: "node -e \"\"", typecheck: "node -e \"\"", build: "node -e \"\"",
    },
  }));
  fs.writeFileSync(path.join(root, "scripts", "link-deps.mjs"), "export {};\n");
}

async function settled(engine: InstanceType<typeof CompanyEngine>, id: string) {
  for (let i = 0; i < 6_000; i++) {
    const run = engine.get(id);
    if (["done", "failed", "cancelled"].includes(run.stage)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("company run did not settle");
}

test("brief: detects fullstack and pauses ambiguous ideas", async () => {
  const brief = await analyzeProductIdea("أنشئ متجرًا إلكترونيًا مع تسجيل الدخول وقاعدة بيانات للطلبات والدفع");
  assert.equal(brief.scenario, "fullstack_app");
  assert.ok(brief.features.includes("fullstack"));
  assert.ok(brief.acceptance.length > 0);
  const vague = await analyzeProductIdea("بناء تطبيق");
  assert.ok(vague.questions.length > 0);
});

test("company: idea to verified version, preview and export", async () => {
  const p = project("verified-product");
  const engine = new CompanyEngine({
    runTask: async () => { writeApp(p); return { taskId: p.taskId, text: "built" }; },
    verify: verifyDeps(),
    devServer: { ensure: async () => "http://127.0.0.1:15173", stop: () => undefined } as never,
    versions: new (await import("../versions.js")).VersionService(versionRows),
  });
  const started = await engine.start(p, "أنشئ متجرًا إلكترونيًا مع تسجيل الدخول وقاعدة بيانات للطلبات والدفع");
  const run = await settled(engine, started.id);
  assert.equal(run.stage, "done", run.error ?? "no error");
  assert.equal(run.versionNumber, 1);
  assert.ok(run.verifyReportId);
  assert.ok(run.previewUrl);
  assert.ok(fs.existsSync(path.join(p.workspaceDir, "SPEC.md")));
  assert.ok(fs.existsSync(path.join(p.workspaceDir, "DESIGN.md")));
  assert.equal(getAppProject(p.id)?.activeVersion, 1);
  assert.equal(getAppProject(p.id)?.description, started.idea);
  assert.ok(getAppProject(p.id)?.features.includes("fullstack"));
  assert.equal(engine.export(run.id).subarray(0, 2).toString(), "PK");
});

test("company: rejects concurrent runs across engine instances", async () => {
  const p = project("exclusive-product");
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const engine = new CompanyEngine({
    runTask: async () => { writeApp(p); await blocked; return { taskId: p.taskId, text: "built" }; },
    verify: verifyDeps(),
  });
  const started = await engine.start(p, "أنشئ لوحة تحليلات للمبيعات مع رسوم وتصفية حسب الفترة");
  try {
    const concurrent = new CompanyEngine({ runTask: async () => { throw new Error("must not run concurrently"); } });
    await assert.rejects(concurrent.start(p, "أنشئ لوحة أخرى للمبيعات مع رسوم وتصفية"), /already active/);
  } finally {
    release();
  }
  const run = await settled(engine, started.id);
  assert.equal(run.stage, "done", run.error ?? "no error");
});

test("company: failed verification never creates a version or export", async () => {
  const p = project("broken-product");
  const engine = new CompanyEngine({
    runTask: async () => { writeApp(p, true); return { taskId: p.taskId, text: "built" }; },
    verify: verifyDeps(true),
  });
  const started = await engine.start(p, "أنشئ صفحة تعريفية للمنتج مع زر بدء الاستخدام");
  const run = await settled(engine, started.id);
  assert.equal(run.stage, "failed");
  assert.equal(run.versionNumber, null);
  assert.throws(() => engine.export(run.id), /verified version/);
});

test("company: approval is required before building ambiguous work", async () => {
  const p = project("approval-product");
  const engine = new CompanyEngine({ runTask: async () => { throw new Error("must not build"); } });
  const started = await engine.start(p, "بناء تطبيق");
  assert.equal(started.stage, "awaiting_approval");
  assert.throws(() => engine.export(started.id), /verified version/);
});
