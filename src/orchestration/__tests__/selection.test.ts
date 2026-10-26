import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDiff, selectBest, type Candidate } from "../selection/selectBest.js";
import { scriptedPort } from "./helpers.js";

const d1 = "diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n ctx\n-old line\n+new line   \n";
const d1b = "diff --git a/src/a.ts b/src/a.ts\nindex 9..8 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,3 +10,3 @@\n other ctx\n-old line\n+new line\n";
const d2 = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old line\n+different fix\n";

test("normalizeDiff ignores hunk positions, context and trailing spaces", () => {
  assert.equal(normalizeDiff(d1), normalizeDiff(d1b));
  assert.notEqual(normalizeDiff(d1), normalizeDiff(d2));
});

const c = (id: string, diff: string, ok = true): Candidate => ({ id, ok, text: `report ${id}`, diff });

test("regression prune keeps passing candidates, or all when none pass", async () => {
  const cands = [c("a", d1), c("b", d2), c("x", d2, false)];
  const r = await selectBest({ goal: "fix", candidates: cands, maxCandidates: 8, check: async (k) => ({ passed: k.id === "b", detail: "" }) });
  assert.equal(r.winnerId, "b");
  assert.equal(r.method, "regression");
  assert.deepEqual(r.pruned.sort(), ["a", "x"]);
  const none = await selectBest({ goal: "fix", candidates: [c("a", d1), c("b", d1b)], maxCandidates: 8, check: async () => ({ passed: false, detail: "" }) });
  assert.equal(none.winnerId, "a");
  assert.equal(none.method, "single");
  assert.equal(none.groups[0]?.length, 2);
});

test("judge vote stops early at a strict majority", async () => {
  const port = scriptedPort([JSON.stringify({ winner: "b", reason: "complete" }), JSON.stringify({ winner: "b", reason: "complete" }), "unused"]);
  const r = await selectBest({ goal: "fix", candidates: [c("a", d1), c("b", d2)], maxCandidates: 8, judge: { port, model: "m:cloud", votes: 3, repairAttempts: 0 } });
  assert.equal(r.winnerId, "b");
  assert.equal(r.method, "judge");
  assert.equal(port.calls.length, 2);
  assert.equal(r.judgeTokens, 240);
});

test("without a judge the largest duplicate group wins", async () => {
  const r = await selectBest({ goal: "fix", candidates: [c("a", d2), c("b", d1), c("c", d1b)], maxCandidates: 8 });
  assert.equal(r.winnerId, "b");
  assert.equal(r.method, "majority");
  const lone = await selectBest({ goal: "fix", candidates: [c("a", d2), c("b", d1)], maxCandidates: 8 });
  assert.equal(lone.method, "first");
  const empty = await selectBest({ goal: "fix", candidates: [c("a", d1, false)], maxCandidates: 8 });
  assert.equal(empty.winnerId, null);
});

test("judge answers naming unknown ids are ignored", async () => {
  const port = scriptedPort([JSON.stringify({ winner: "zzz", reason: "?" }), JSON.stringify({ winner: "zzz", reason: "?" }), JSON.stringify({ winner: "zzz", reason: "?" })]);
  const r = await selectBest({ goal: "fix", candidates: [c("a", d1), c("b", d2)], maxCandidates: 8, judge: { port, model: "m:cloud", votes: 3, repairAttempts: 0 } });
  assert.equal(r.method, "first");
  assert.equal(r.winnerId, "a");
});
