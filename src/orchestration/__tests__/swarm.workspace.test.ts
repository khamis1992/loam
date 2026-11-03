import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  addWorkerWorktree, claimBranch, currentBranch, initRunRepo, isClean,
  mainCommitCount, mainMergeCount, mergeWorkerBranch, removeWorktrees, switchClaimBranch,
} from "../swarm/workspace.js";
import { git, tmpDir } from "./swarmHelpers.js";

const gitIn = (cwd: string) => (...args: string[]) => git(cwd, args);

async function seedFile(root: string, rel: string, content: string): Promise<void> {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

test("AC-S2.1 run repo on main with one worktree per worker; .loam/realswarm/ never committed", async () => {
  const root = tmpDir();
  assert.equal(await initRunRepo(root), true);
  assert.equal((await currentBranch(root)), "main");
  await seedFile(root, "hello.txt", "hi\n");
  const g = gitIn(root);
  await g("add", "-A");
  await g("commit", "-m", "seed");
  const w1 = await addWorkerWorktree(root, "w1");
  const w2 = await addWorkerWorktree(root, "w2");
  assert.ok(fs.existsSync(path.join(w1, "hello.txt")));
  assert.ok(fs.existsSync(path.join(w2, "hello.txt")));
  assert.equal((await currentBranch(w1)), claimBranch("w1", "start"));
  const listed = await g("worktree", "list", "--porcelain");
  assert.ok(listed.includes(w1.replaceAll("\\", "/")) || listed.includes(w1));
  // The exclude file hides the coordination dir from commits.
  const exclude = fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8");
  assert.ok(exclude.includes(".loam/realswarm/"));
  fs.mkdirSync(path.join(root, ".loam", "realswarm"), { recursive: true });
  fs.writeFileSync(path.join(root, ".loam", "realswarm", "coord.sqlite"), "x");
  await g("add", "-A");
  await g("status", "--porcelain");
  const committed = await g("ls-files");
  assert.ok(!committed.includes("coord.sqlite"), "coordination dir never staged");
});

test("AC-S2.2 a CLAIM switches to worker/<id>/<label> from main; a dirty tree is never switched", async () => {
  const root = tmpDir();
  await initRunRepo(root);
  await seedFile(root, "a.txt", "base\n");
  const g = gitIn(root);
  await g("add", "-A"); await g("commit", "-m", "base");
  const w1 = await addWorkerWorktree(root, "w1");
  const sw = await switchClaimBranch(w1, "w1", "parser");
  assert.equal(sw.ok, true);
  assert.equal(await currentBranch(w1), claimBranch("w1", "parser"));
  // switch back to an existing label works
  await switchClaimBranch(w1, "w1", "other");
  const back = await switchClaimBranch(w1, "w1", "parser");
  assert.equal(back.ok, true);
  // dirty tree refuses
  await seedFile(w1, "dirty.txt", "x");
  assert.equal(await isClean(w1), false);
  const dirty = await switchClaimBranch(w1, "w1", "third");
  assert.equal(dirty.ok, false);
  assert.match(dirty.note, /uncommitted changes/);
  assert.equal(await currentBranch(w1), claimBranch("w1", "parser"));
});

test("AC-S2.3 engine no-ff merge, noop, conflict abort and later resolve", async () => {
  const root = tmpDir();
  await initRunRepo(root);
  await seedFile(root, "shared.txt", "base\n");
  const g = gitIn(root);
  await g("add", "-A"); await g("commit", "-m", "base");

  // noop: branch with no changes
  const w1 = await addWorkerWorktree(root, "w1");
  await switchClaimBranch(w1, "w1", "empty");
  const noop = await mergeWorkerBranch(root, claimBranch("w1", "empty"), "m: empty");
  assert.equal(noop.status, "noop");

  // merged: a real change lands with --no-ff and a commit sha
  await seedFile(w1, "w1.txt", "from w1\n");
  const g1 = gitIn(w1);
  await g1("add", "-A"); await g1("commit", "-m", "w1 change");
  const merged = await mergeWorkerBranch(root, claimBranch("w1", "empty"), "realswarm: w1 empty");
  assert.equal(merged.status, "merged");
  assert.ok(merged.commit && merged.commit.length >= 7);
  assert.deepEqual(merged.changedFiles, ["w1.txt"]);
  assert.ok(fs.readFileSync(path.join(root, "w1.txt"), "utf8").includes("from w1"));

  // conflict: main and branch edit the same line; merge aborts cleanly, main unchanged
  const w2 = await addWorkerWorktree(root, "w2");
  await switchClaimBranch(w2, "w2", "clash");
  await seedFile(w2, "shared.txt", "w2 version\n");
  const g2 = gitIn(w2);
  await g2("add", "-A"); await g2("commit", "-m", "w2 edit");
  await seedFile(root, "shared.txt", "main version\n");
  await g("add", "-A"); await g("commit", "-m", "main edit");
  const before = await mainCommitCount(root);
  const conflict = await mergeWorkerBranch(root, claimBranch("w2", "clash"), "m: clash");
  assert.equal(conflict.status, "conflict");
  assert.deepEqual(conflict.conflicts, ["shared.txt"]);
  assert.equal(await mainCommitCount(root), before, "main unchanged after the abort");
  assert.equal((await g("status", "--porcelain")), "", "no unresolved files left");

  // resolve: the worker merges main in, fixes the file, the merge then lands
  await g2("merge", "main").catch(() => undefined); // CONFLICT (content) in shared.txt is the expected step of the resolve flow
  await seedFile(w2, "shared.txt", "resolved\n");
  await g2("add", "-A"); await g2("commit", "-m", "resolve");
  const landed = await mergeWorkerBranch(root, claimBranch("w2", "clash"), "m: clash resolved");
  assert.equal(landed.status, "merged");
  assert.ok(fs.readFileSync(path.join(root, "shared.txt"), "utf8").includes("resolved"));
  assert.equal(await mainMergeCount(root), 2);
});

test("AC-S2.4 merges of one run are serialized (no interleaving)", async () => {
  const root = tmpDir();
  await initRunRepo(root);
  await seedFile(root, "a.txt", "a\n");
  const g = gitIn(root);
  await g("add", "-A"); await g("commit", "-m", "base");
  const w1 = await addWorkerWorktree(root, "w1");
  await switchClaimBranch(w1, "w1", "x");
  await seedFile(w1, "x.txt", "x\n");
  const g1 = gitIn(w1);
  await g1("add", "-A"); await g1("commit", "-m", "x");
  const order: string[] = [];
  // Both merges of the same run race; the chain must serialize them. The second is a
  // fast no-op-after-merge (branch already merged) but must still run AFTER the first.
  const p1 = mergeWorkerBranch(root, claimBranch("w1", "x"), "m1").then((r) => order.push(`1:${r.status}`));
  const p2 = mergeWorkerBranch(root, claimBranch("w1", "x"), "m2").then((r) => order.push(`2:${r.status}`));
  await Promise.all([p1, p2]);
  assert.equal(order.length, 2);
  assert.equal(await mainMergeCount(root), 1, "the branch merged exactly once");
  // worktrees are removed at run end, branches stay
  const removed = await removeWorktrees(root);
  assert.ok(removed >= 1);
  assert.ok(!fs.existsSync(path.join(root, ".loam", "realswarm", "workers", "w1")));
  assert.equal((await g("rev-parse", "--verify", claimBranch("w1", "x")).then(() => true, () => false)), true, "branch kept for provenance");
});
