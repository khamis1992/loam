import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSimpleCrudApp, isSimpleCrudRequest } from "../simpleCrud.js";
import { checkDesignDoc } from "../designDoc.js";
import type { AppProject } from "../types.js";

test("simple CRUD routing accepts only focused task-list requests", () => {
  assert.equal(isSimpleCrudRequest("Build a simple Todo List web app with add, complete, and delete tasks."), true);
  assert.equal(isSimpleCrudRequest("اعمل تطبيق قائمة مهام بسيط"), true);
  assert.equal(isSimpleCrudRequest("Build a task tracker with login and team sync"), false);
  assert.equal(isSimpleCrudRequest("Build a presentation about productivity"), false);
  assert.equal(isSimpleCrudRequest("Build a dashboard for sales"), false);
});

test("deterministic task app writes a valid design and passes its behavior checks", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-simple-crud-"));
  const project: Pick<AppProject, "workspaceDir" | "appDir"> = { workspaceDir, appDir: "app" };
  try {
    buildSimpleCrudApp(project);
    const appDir = path.join(workspaceDir, "app");
    const page = fs.readFileSync(path.join(appDir, "src", "pages", "Index.tsx"), "utf8");
    assert.ok(page.includes("Tidy"));
    assert.ok(!page.includes("LOAM_PLACEHOLDER_PAGE"));
    assert.ok(checkDesignDoc(fs.readFileSync(path.join(workspaceDir, "DESIGN.md"), "utf8")).ok);
    const manifest = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8")) as { scripts: Record<string, string> };
    for (const command of ["check", "lint", "typecheck", "build"]) assert.ok(manifest.scripts[command]);
    execFileSync(process.execPath, ["--experimental-strip-types", "--test", "tests/todos.check.mjs"], { cwd: appDir, stdio: "pipe" });
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});
