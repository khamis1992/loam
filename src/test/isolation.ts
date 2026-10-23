/**
 * Test isolation for the app data and workspace directories.
 *
 * `DATA_DIR` is a module-level constant in `src/config.ts`, so any test that
 * transitively imports the config module (the agent prompt, the loop, the tool
 * registry, the event log) pins it to the repository's real `data/` folder.
 * Building a system prompt reads user personalization from that store, which
 * means a bare unit test can create or mutate `data/manus.db` inside the repo -
 * the same file a developer's real app data lives in.
 *
 * `loadConfig()` is worse: it eagerly creates `workspace/` and
 * `workspace/.screenshots/` (and `data/`, `evals/`) as a side effect, so merely
 * importing a module that calls it writes into the source tree. `LOAM_ROOT` is
 * the knob for that pair. `ROOT` still resolves to this package (the temp root
 * has no `package.json`, so `resolveRoot()` falls through to the file path),
 * which keeps `UI_DIR`/`SCRIPTS_DIR` pointing at the real tree.
 *
 * Import this module *first*, before any value import that pulls in `config.ts`.
 * ESM evaluates static imports in source order, so the assignment below runs
 * before the config module is evaluated and the folders are redirected to a
 * per-process temp directory.
 *
 * The module only imports node builtins on purpose: importing `config.ts` here
 * would evaluate it before the redirect is applied.
 *
 * Usage:
 *   import "../test/isolation.js";
 *   const { closeDb } = await import("../../server/sqliteStore.js");
 *   after(() => { closeDb(); cleanupIsolatedDataDir(); });
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-test-data-"));
process.env.MANUS_LOCAL_DATA_DIR = path.join(tmp, "data");
process.env.MANUS_LOCAL_EVALS_DIR = path.join(tmp, "evals");
// `loadConfig()` mkdirs `workspace/` and `workspace/.screenshots/` from this root.
process.env.LOAM_ROOT = tmp;

/** The temp root this process was redirected to. */
export function isolatedDataDir(): string {
  return tmp;
}

/**
 * Remove the temp tree. Call `closeDb()` first: the SQLite handle is opened
 * lazily under the data dir and an open handle makes removal fail with EPERM on
 * Windows. Cleanup failures are reported, never swallowed, so a leak is visible.
 */
export function cleanupIsolatedDataDir(): void {
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    console.error(`[test isolation] failed to remove ${tmp}: ${String(error)}`);
  }
}
