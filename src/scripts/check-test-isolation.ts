/**
 * Guard: the test suite must not write into the repository's real `data/` or
 * `workspace/` folders.
 *
 * `src/config.ts` derives `DATA_DIR` from `MANUS_LOCAL_DATA_DIR` (defaulting to
 * the repo's `data/`). Any test that transitively imports it without redirecting
 * first will create or mutate that folder - the same SQLite file a developer's
 * own app data lives in. `src/test/isolation.ts` closes the known leaks, but a
 * single new `import { buildSystemPrompt }` silently reopens them.
 *
 * This script copies the repository (minus build output) to a temp folder,
 * deletes `data/` and `workspace/`, runs the whole server suite there, and fails
 * if either folder reappears. It is the standing feedback loop for that
 * contract, not a one-off assertion.
 *
 * `node_modules` is linked rather than copied so the run resolves the same
 * dependency tree without duplicating hundreds of megabytes.
 *
 * Run: npm run check:test-isolation
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const GUARDED_DIRS = ["data", "workspace"] as const;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "out"]);

/**
 * Every path left behind under a guarded folder. An empty folder means a test
 * created it and wrote nothing, which still counts as writing into the tree; the
 * paths make the offending suite obvious.
 */
function residuePaths(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string, rel: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, next);
      else found.push(next);
    }
  };
  walk(dir, "");
  return found.sort();
}

function copyTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function linkNodeModules(dest: string): () => void {
  const link = path.join(dest, "node_modules");
  fs.symlinkSync(path.join(root, "node_modules"), link, "junction");
  return () => fs.rmSync(link, { recursive: true, force: true });
}

function collectTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTestFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-test-isolation-"));
try {
  const sandbox = path.join(tmp, "repo");
  copyTree(root, sandbox);
  const unlinkNodeModules = linkNodeModules(sandbox);
  try {
    for (const name of GUARDED_DIRS) fs.rmSync(path.join(sandbox, name), { recursive: true, force: true });

    const files = collectTestFiles(path.join(sandbox, "src")).sort();
    assert.ok(files.length > 100, `expected a substantial suite, found ${files.length} test files`);

    let exitCode = 0;
    let output = "";
    try {
      output = execFileSync(
        process.execPath,
        ["--import", "tsx", "--test", "--test-reporter=tap", ...files],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28, cwd: sandbox },
      );
    } catch (error) {
      exitCode = error.status ?? -1;
      output = String(error.stdout ?? "") + String(error.stderr ?? "");
    }

    const residue = Object.fromEntries(
      GUARDED_DIRS.filter((name) => fs.existsSync(path.join(sandbox, name))).map((name) => [
        name,
        residuePaths(path.join(sandbox, name)),
      ]),
    );
    const leaked = Object.keys(residue);
    assert.deepEqual(
      leaked,
      [],
      `the test suite wrote into the repository tree: ${leaked.join(", ")}\n` +
        `paths: ${JSON.stringify(residue, null, 2)}\n` +
        `suite exit=${exitCode}\n${output.slice(-4000)}`,
    );
    console.log(`check:test-isolation OK (${files.length} test files, no repo data/ or workspace/ written)`);
  } finally {
    unlinkNodeModules();
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
