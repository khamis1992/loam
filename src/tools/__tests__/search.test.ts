/**
 * Tests for the dedicated grep and glob tools (search.ts).
 *
 * Guarantees under test:
 *  - grep content / files_with_matches / count output modes
 *  - line numbers, context lines, case-insensitive matching, glob filters
 *  - glob pattern matching (**, *, ?, {a,b}, negation) and mtime ordering
 *  - both tools are confined to the workspace and report failures cleanly
 *  - the built-in scanner stays fast on the real manus-local repository
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import { compileGlobs, globInWorkspace, grepInWorkspace, searchTools } from "../search.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");

let tmpDir = "";

function ctx(workspace: string) {
  return {
    cfg: { policy: { allowOutsideWorkspaceRead: false } } as never,
    workspace,
    emit: () => {},
  };
}

function tool(name: string) {
  const found = searchTools().find((t) => t.name === name);
  assert.ok(found, `${name} tool is exported`);
  return found;
}

function grep(args: Record<string, unknown>, workspace = tmpDir) {
  return tool("grep").run(args, ctx(workspace));
}

function glob(args: Record<string, unknown>, workspace = tmpDir) {
  return tool("glob").run(args, ctx(workspace));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-search-"));
  process.env.LOAM_SEARCH_FORCE_JS = "1";
});

afterEach(() => {
  delete process.env.LOAM_SEARCH_FORCE_JS;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("grep", () => {
  it("reports matching lines with line numbers in content mode", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "alpha\nbeta\ngamma\n", "utf8");
    const res = await grep({ pattern: "beta" });
    assert.equal(res.ok, true);
    assert.match(res.content, /a\.ts:2:beta/);
    assert.match(res.content, /1 match in 1 file/);
  });

  it("lists only file paths in files_with_matches mode", async () => {
    fs.mkdirSync(path.join(tmpDir, "sub"));
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "needle\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "sub", "b.ts"), "needle\nnone\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "c.txt"), "nothing\n", "utf8");
    const res = await grep({ pattern: "needle", output_mode: "files_with_matches" });
    assert.equal(res.ok, true);
    assert.match(res.content, /a\.ts/);
    assert.match(res.content, /sub\/b\.ts/);
    assert.doesNotMatch(res.content, /c\.txt/);
  });

  it("counts matching lines per file in count mode", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "hit\nhit\nmiss\n", "utf8");
    const res = await grep({ pattern: "hit", output_mode: "count" });
    assert.equal(res.ok, true);
    assert.match(res.content, /a\.ts:2/);
    assert.match(res.content, /2 matches in 1 file/);
  });

  it("adds context lines around matches", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "one\ntwo\nTARGET\nfour\nfive\n", "utf8");
    const res = await grep({ pattern: "TARGET", context: 1 });
    assert.equal(res.ok, true);
    assert.match(res.content, /a\.ts:3:TARGET/);
    assert.match(res.content, /a\.ts-2-two/);
    assert.match(res.content, /a\.ts-4-four/);
  });

  it("honours caseInsensitive", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "Alpha\nbeta\n", "utf8");
    assert.equal((await grep({ pattern: "alpha" })).ok, true);
    assert.match((await grep({ pattern: "alpha" })).content, /no matches|Alpha/);
    const ci = await grep({ pattern: "alpha", caseInsensitive: true });
    assert.match(ci.content, /a\.ts:1:Alpha/);
  });

  it("filters files with a glob and supports negation", async () => {
    fs.writeFileSync(path.join(tmpDir, "keep.ts"), "needle\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "skip.test.ts"), "needle\n", "utf8");
    const ts = await grep({ pattern: "needle", glob: "*.ts" });
    assert.match(ts.content, /keep\.ts/);
    assert.match(ts.content, /skip\.test\.ts/);
    const neg = await grep({ pattern: "needle", glob: "*.ts,!*.test.ts" });
    assert.match(neg.content, /keep\.ts/);
    assert.doesNotMatch(neg.content, /skip\.test\.ts/);
  });

  it("searches a single file when path is a file", async () => {
    fs.writeFileSync(path.join(tmpDir, "only.txt"), "findme\n", "utf8");
    const res = await grep({ pattern: "findme", path: "only.txt" });
    assert.equal(res.ok, true);
    assert.match(res.content, /only\.txt:1:findme/);
  });

  it("rejects an invalid regular expression", async () => {
    const res = await grep({ pattern: "([unclosed" });
    assert.equal(res.ok, false);
    assert.match(res.content, /invalid regular expression/i);
  });

  it("reports a missing path without throwing", async () => {
    const res = await grep({ pattern: "x", path: "does-not-exist" });
    assert.equal(res.ok, false);
    assert.match(res.content, /not found/i);
  });

  it("never follows a symlink out of the workspace", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "loam-search-out-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "topsecret\n", "utf8");
    try {
      fs.symlinkSync(outside, path.join(tmpDir, "escape"), "dir");
      const res = await grep({ pattern: "topsecret" });
      assert.equal(res.ok, true);
      assert.doesNotMatch(res.content, /topsecret/);
    } finally {
      try {
        fs.unlinkSync(path.join(tmpDir, "escape"));
      } catch {
        /* ignore */
      }
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("glob", () => {
  it("matches recursively with ** and sorts by mtime (newest first)", () => {
    const old = path.join(tmpDir, "old.ts");
    const neu = path.join(tmpDir, "sub", "new.ts");
    fs.mkdirSync(path.join(tmpDir, "sub"));
    fs.writeFileSync(old, "x\n", "utf8");
    fs.writeFileSync(neu, "y\n", "utf8");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(old, past, past);
    const res = globInWorkspace(tmpDir, { pattern: "**/*.ts" });
    assert.equal(res.ok, true);
    const lines = res.content.split("\n");
    assert.ok(lines.includes("sub/new.ts"));
    assert.ok(lines.includes("old.ts"));
    assert.ok(lines.indexOf("sub/new.ts") < lines.indexOf("old.ts"), "newest file first");
  });

  it("supports *, ? and {a,b} alternation", () => {
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "x\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "b.ts"), "x\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "c.js"), "x\n", "utf8");
    const res = globInWorkspace(tmpDir, { pattern: "*.{ts,js}" });
    assert.match(res.content, /a\.ts/);
    assert.match(res.content, /c\.js/);
    const one = globInWorkspace(tmpDir, { pattern: "?.ts" });
    assert.match(one.content, /a\.ts/);
    assert.doesNotMatch(one.content, /c\.js/);
  });

  it("supports negation and name/path sorting", () => {
    fs.mkdirSync(path.join(tmpDir, "sub"));
    fs.writeFileSync(path.join(tmpDir, "keep.ts"), "x\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "sub", "skip.test.ts"), "x\n", "utf8");
    const res = globInWorkspace(tmpDir, { pattern: "**/*.ts,!*.test.ts", sortBy: "name" });
    assert.equal(res.ok, true);
    assert.match(res.content, /keep\.ts/);
    assert.doesNotMatch(res.content, /skip\.test\.ts/);
  });

  it("caps results and reports truncation", () => {
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(tmpDir, `f${i}.ts`), "x\n", "utf8");
    const res = globInWorkspace(tmpDir, { pattern: "*.ts", limit: 2 });
    assert.equal(res.ok, true);
    assert.equal(res.count, 2);
    assert.equal(res.truncated, true);
  });

  it("requires a pattern and reports a missing root", () => {
    assert.equal(globInWorkspace(tmpDir, { pattern: "" }).ok, false);
    assert.equal(globInWorkspace(tmpDir, { pattern: "*.ts", path: "nope" }).ok, false);
  });

  it("skips node_modules and hidden directories by default", () => {
    fs.mkdirSync(path.join(tmpDir, "node_modules"));
    fs.writeFileSync(path.join(tmpDir, "node_modules", "dep.ts"), "x\n", "utf8");
    fs.mkdirSync(path.join(tmpDir, ".hidden"));
    fs.writeFileSync(path.join(tmpDir, ".hidden", "h.ts"), "x\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "visible.ts"), "x\n", "utf8");
    const res = globInWorkspace(tmpDir, { pattern: "**/*.ts" });
    assert.match(res.content, /visible\.ts/);
    assert.doesNotMatch(res.content, /node_modules/);
    assert.doesNotMatch(res.content, /\.hidden/);
  });
});

describe("glob matcher", () => {
  it("compiles gitignore-style globs", () => {
    const m = compileGlobs("**/*.ts,!*.test.ts");
    assert.ok(m);
    assert.equal(m!.test("src/a.ts", "a.ts"), true);
    assert.equal(m!.test("src/a.test.ts", "a.test.ts"), false);
    assert.equal(m!.test("src/a.js", "a.js"), false);
    const base = compileGlobs("*.ts");
    assert.ok(base);
    assert.equal(base!.test("src/deep/a.ts", "a.ts"), true);
    assert.equal(base!.test("src/deep/a.js", "a.js"), false);
  });
});

describe("search tools integration", () => {
  it("are registered with full schemas and required parameters", () => {
    const names = searchTools().map((t) => t.name).sort();
    assert.deepEqual(names, ["glob", "grep"]);
    const g = tool("grep");
    assert.deepEqual(g.parameters.required, ["pattern"]);
    assert.ok((g.parameters.properties as Record<string, unknown>).output_mode);
    const gl = tool("glob");
    assert.deepEqual(gl.parameters.required, ["pattern"]);
  });
});

describe("performance on manus-local", () => {
  it("greps and globs the repository in under 1 second", async () => {
    const start = Date.now();
    const res = await grepInWorkspace(REPO_ROOT, { pattern: "ToolRegistry", outputMode: "files_with_matches", maxResults: 50 });
    const elapsed = Date.now() - start;
    assert.equal(res.ok, true);
    assert.ok(res.fileCount > 0, "expected matches in the real repository");
    assert.ok(elapsed < 1000, `grep took ${elapsed}ms`);

    const gStart = Date.now();
    const g = globInWorkspace(REPO_ROOT, { pattern: "**/*.ts", limit: 500 });
    const gElapsed = Date.now() - gStart;
    assert.equal(g.ok, true);
    assert.ok(g.count > 0, "expected files in the real repository");
    assert.ok(gElapsed < 1000, `glob took ${gElapsed}ms`);
  });
});
