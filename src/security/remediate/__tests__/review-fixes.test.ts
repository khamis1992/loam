/** Review fixes — regression tests for the two bugs found in the 2026-10-25 full
 *  system review: (1) remediation_start must anchor to the ACTIVE TASK WORKSPACE,
 *  never the server cwd (the app repo); (2) the inventory walk must never descend
 *  into the run store — old worktrees there still carry the vulnerable pins and
 *  would count as phantom rows inside the user-approved plan hash. */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setRemediationDataDir, startRemediation } from "../index.js";
import { DATA_DIR } from "../../../config.js";
import { FIXTURES, materialize } from "./fixtures.js";

const fixture = FIXTURES.find((f) => f.name === "node-vuln-app")!;
let parent = "";

beforeEach(() => { parent = fs.mkdtempSync(path.join(os.tmpdir(), "rem-fix-")); });
afterEach(() => { setRemediationDataDir(DATA_DIR); fs.rmSync(parent, { recursive: true, force: true }); });

test("the run store never leaks into a workspace inventory", async () => {
  // Repo with a data dir that mimics production: a leftover run-store worktree
  // holding an OLD vulnerable pin must not appear as an inventory row.
  const repo = materialize(fixture, parent);
  const dataDir = path.join(repo, "data");
  const leftover = path.join(dataDir, "security-remediations", "old-run", "worktrees", "node-vuln-app");
  fs.mkdirSync(leftover, { recursive: true });
  fs.writeFileSync(path.join(leftover, "Dockerfile"), "FROM node:20.19.0-alpine\n"); // distinct marker
  setRemediationDataDir(dataDir);
  const run = await startRemediation({ repos: [repo] }, "test");
  const leaked = run.inventory.filter((r) => r.hit.file.includes("security-remediations") || r.hit.file.includes(`${path.sep}data${path.sep}`));
  assert.deepEqual(leaked, [], `run-store copies leaked: ${JSON.stringify(leaked.map((r) => r.hit.file))}`);
  assert.equal(run.inventory.length, fixture.expect.length, "only the real fixture rows remain");
});

test("remediation_start anchors to the task workspace and resolves relative repos against it", async () => {
  const { createRemediateTools } = await import("../../../tools/remediateTools.js");
  const workspace = materialize(fixture, parent);
  const store = fs.mkdtempSync(path.join(parent, "store-")); // mkdtemp appends random chars — keep the real path
  setRemediationDataDir(store);
  const ctx = { cfg: { model: "glm-5.3-flash:cloud" }, workspace } as never;
  const start = createRemediateTools().find((t) => t.name === "remediation_start")!;

  const res = await start.run({}, ctx);
  const runId = JSON.parse(res.content).run_id as string;
  const { readRun } = await import("../store.js");
  const run = readRun(runId, store)!;
  assert.ok(run, "run persisted");
  assert.equal(path.resolve(run.repoDirs![run.repos[0]!]!), path.resolve(workspace), "default target must be ctx.workspace, never cwd");
  assert.equal(run.inventory.length, fixture.expect.length, "the task workspace was actually scanned");

  // Relative repo paths resolve against the workspace too.
  const res2 = await start.run({ repos: ["."] }, ctx);
  const run2 = readRun(JSON.parse(res2.content).run_id as string, store)!;
  assert.equal(path.resolve(run2.repoDirs![run2.repos[0]!]!), path.resolve(workspace), "relative repos anchor to ctx.workspace");
});
