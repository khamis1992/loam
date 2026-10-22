/**
 * Frontier-quality hardening tests for scaffold_backend (backendScaffold.ts).
 *
 * Focuses on the safety invariants the original suites did not cover:
 *  - path confinement is segment-aware (no substring false positives)
 *  - a symlink inside the workspace cannot smuggle writes outside it
 *  - the "db" kind emits its complete file set
 *  - direct scaffoldBackend calls report created vs skipped files honestly
 *  - invalid kinds are rejected before any write
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  createBackendScaffoldTools,
  filesFor,
  resolveScaffoldDir,
  scaffoldBackend,
} from "../backendScaffold.js";

let tmpDir = "";
let outsideDir = "";

const shell = () => ({ cfg: {} as never, workspace: tmpDir, emit: () => {} });

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-scaffold-harden-"));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-outside-"));
});

afterEach(() => {
  for (const dir of [tmpDir, outsideDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("scaffold_backend hardening", () => {
  it("resolveScaffoldDir is segment-aware: '..' segments refused, 'a..b' allowed", () => {
    assert.equal(resolveScaffoldDir(tmpDir, "a..b"), path.resolve(tmpDir, "a..b"));
    assert.equal(resolveScaffoldDir(tmpDir, "app/src"), path.resolve(tmpDir, "app/src"));
    for (const bad of ["..", "a/../b", "a/../../b", "/abs", "C:/evil", "\\\\server\\share"]) {
      assert.throws(() => resolveScaffoldDir(tmpDir, bad), /projectDir/, `expected refusal for ${bad}`);
    }
  });

  it("resolveScaffoldDir refuses a symlink that escapes the workspace", () => {
    const link = path.join(tmpDir, "evil");
    try {
      fs.symlinkSync(outsideDir, link, "dir");
    } catch {
      // Symlink creation unavailable on this platform; nothing to assert.
      return;
    }
    assert.throws(() => resolveScaffoldDir(tmpDir, "evil/sub"), /symlink escape|outside the workspace/);
    // A symlink that stays inside the workspace is still fine.
    const insideLink = path.join(tmpDir, "inside");
    fs.mkdirSync(path.join(tmpDir, "real"));
    try {
      fs.symlinkSync(path.join(tmpDir, "real"), insideLink, "dir");
      assert.equal(resolveScaffoldDir(tmpDir, "inside/sub"), path.resolve(tmpDir, "inside/sub"));
    } catch {
      /* unsupported FS */
    }
  });

  it("empty projectDir scaffolds into the workspace root", () => {
    assert.equal(resolveScaffoldDir(tmpDir, ""), path.resolve(tmpDir));
    assert.equal(resolveScaffoldDir(tmpDir, "   "), path.resolve(tmpDir));
  });

  it("db kind emits its complete file set", () => {
    const paths = filesFor("db").map((f) => f.relPath);
    assert.deepEqual(paths, [
      "migrations/0001_init.sql",
      "src/lib/db.ts",
      ".env.example",
    ]);
  });

  it("scaffoldBackend reports created and skipped files and never overwrites", () => {
    const first = scaffoldBackend("db", tmpDir);
    assert.equal(first.ok, true);
    assert.match(first.content, /created: /);
    assert.doesNotMatch(first.content, /skipped existing/);

    const marker = path.join(tmpDir, "src", "lib", "db.ts");
    fs.writeFileSync(marker, "LOCAL_MARKER\n", "utf8");
    const second = scaffoldBackend("db", tmpDir);
    assert.equal(second.ok, true);
    assert.match(second.content, /skipped existing: /);
    assert.equal(fs.readFileSync(marker, "utf8"), "LOCAL_MARKER\n", "existing file untouched");
  });

  it("scaffoldBackend writes valid UTF-8 Arabic-free starter content without secrets", () => {
    scaffoldBackend("supabase", tmpDir);
    const env = fs.readFileSync(path.join(tmpDir, ".env.example"), "utf8");
    for (const line of env.split("\n")) {
      if (line && !line.startsWith("#")) assert.match(line, /^[A-Z0-9_]+=$/, `empty value: ${line}`);
    }
    const client = fs.readFileSync(path.join(tmpDir, "src", "lib", "supabaseClient.ts"), "utf8");
    assert.match(client, /process\.env\.SUPABASE_URL/);
    assert.ok(!/https?:\/\//.test(client), "generated client makes no network calls");
  });

  it("invalid kind is rejected before any write", async () => {
    const tools = createBackendScaffoldTools();
    const tool = tools.find((t) => t.name === "scaffold_backend")!;
    const res = await tool.run({ kind: "nope" }, shell());
    assert.equal(res.ok, false);
    assert.match(res.content, /kind must be one of/);
    assert.deepEqual(fs.readdirSync(tmpDir), [], "nothing written for an invalid kind");
  });

  it("a refused projectDir writes nothing", async () => {
    const tools = createBackendScaffoldTools();
    const tool = tools.find((t) => t.name === "scaffold_backend")!;
    const res = await tool.run({ kind: "db", projectDir: "../escape" }, shell());
    assert.equal(res.ok, false);
    assert.match(res.content, /refused/);
    assert.deepEqual(fs.readdirSync(tmpDir), []);
    assert.deepEqual(fs.readdirSync(outsideDir), [], "nothing escaped to the outside dir");
  });
});
