import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CoordinationDb } from "../swarm/board.js";
import { createBoardTools } from "../swarm/boardTools.js";
import { buildWorkerRegistry } from "../swarm/worker.js";
import { isOpenClaim } from "../swarm/admission.js";
import { BOARD_TOOL_NAMES } from "../swarm/types.js";
import { baseTools, tmpDir } from "./swarmHelpers.js";
import path from "node:path";

function freshDb(): CoordinationDb { return new CoordinationDb(":memory:", () => 1_000); }

test("AC-S0.1 a CLAIM with a work label is admitted and rendered as an open claim", () => {
  const db = freshDb();
  const r = db.boardWrite({ thread_id: "w1", type: "CLAIM", content: "own the parser area", work_label: "parser" });
  assert.equal(r.status, "admitted");
  assert.equal(r.label, "G1");
  const view = db.boardRead();
  assert.match(view.rendered, /\[w1\/CLAIM/);
  assert.ok(view.entries.some((e) => isOpenClaim(e, 1_000)));
});

test("AC-S0.2 PATCH_SUMMARY evidence gate", () => {
  const db = freshDb();
  const bad = db.boardWrite({ thread_id: "w1", type: "PATCH_SUMMARY", content: "files=a.ts | idea=x | evidence=pending", work_label: "p" });
  assert.equal(bad.status, "rejected");
  assert.ok(bad.reason!.includes("ps_invalid_ev"));
  const good = db.boardWrite({ thread_id: "w1", type: "PATCH_SUMMARY", content: "files=a.ts | idea=x | evidence=node --test passes", work_label: "p" });
  assert.equal(good.status, "admitted");
  assert.equal(db.entries().find((e) => e.type === "PATCH_SUMMARY")?.verified_checkpoint, true);
});

test("AC-S0.3 a FAIL by the same author on the same label invalidates the latest patch", () => {
  const db = freshDb();
  db.boardWrite({ thread_id: "w1", type: "CLAIM", content: "own parser", work_label: "parser" });
  db.boardWrite({ thread_id: "w1", type: "PATCH_SUMMARY", content: "files=a | idea=x | evidence=tests pass", work_label: "parser" });
  db.boardWrite({ thread_id: "w1", type: "FAIL", content: "node --test still fails on a.ts", work_label: "parser" });
  const patch = db.entries().find((e) => e.type === "PATCH_SUMMARY")!;
  assert.equal(patch.verified_checkpoint, false);
  assert.ok(patch.invalidated_by_fail);
});

test("AC-S0.4 expired claims leave the live board but stay searchable", async () => {
  const db = new CoordinationDb(":memory:");
  db.boardWrite({ thread_id: "w1", type: "CLAIM", content: "own the docs area", work_label: "docs", ttl_seconds: 1 });
  assert.match(db.boardRead().rendered, /CLAIM/);
  await new Promise((r) => setTimeout(r, 1_100));
  assert.ok(!db.boardRead().rendered.includes("CLAIM]"));
  assert.equal(db.boardGrep("docs", "", 10).length, 1);
});

test("AC-S0.5 rendering keeps distinct claims, hides closed claims (U12) and replaces a re-posted patch", () => {
  const db = freshDb();
  db.boardWrite({ thread_id: "w1", type: "CLAIM", content: "own parser", work_label: "parser" });
  db.boardWrite({ thread_id: "w2", type: "CLAIM", content: "own http api", work_label: "http-api" });
  db.boardWrite({ thread_id: "w1", type: "FACT", content: "repo uses node:test" });
  db.boardWrite({ thread_id: "w1", type: "FACT", content: "repo uses node:test" });
  db.boardWrite({ thread_id: "w1", type: "PATCH_SUMMARY", content: "files=a | idea=1 | evidence=verified v1", work_label: "parser" });
  db.boardWrite({ thread_id: "w1", type: "PATCH_SUMMARY", content: "files=a | idea=2 | evidence=verified v2", work_label: "parser" });
  const rendered = db.boardRead().rendered;
  // Distinctness is over ALL claims (entries): w1's claim is closed by its own patch below,
  // which is exactly the U12 rule under test, so the rendered open-view shows only w2's.
  const claimCount = db.entries().filter((e) => e.type === "CLAIM").length;
  assert.equal(claimCount, 2, "two distinct claims stay");
  assert.ok(rendered.includes("v2") && !rendered.includes("v1"), "the re-posted patch replaces the earlier one");
  assert.ok(rendered.includes("(x2)"), "duplicate FACT collapsed");
  // w1's patch closes its claim: the claim leaves the open view.
  assert.ok(!rendered.includes("[w1/CLAIM"), "claim closed by its author's patch");
});

test("AC-S0.6 coordination DB on disk runs in WAL mode", () => {
  const dir = tmpDir();
  const db = new CoordinationDb(path.join(dir, "coord.sqlite"));
  assert.equal(db.journalMode(), "wal");
  db.close();
});

test("overlapping claims get a notice, not a rejection", () => {
  const db = freshDb();
  db.boardWrite({ thread_id: "w1", type: "CLAIM", content: "fix the http parser module now", work_label: "parser" });
  const r = db.boardWrite({ thread_id: "w2", type: "CLAIM", content: "fix the http parser module", work_label: "p2" });
  assert.equal(r.status, "admitted");
  assert.ok(r.overlap && r.overlap.holder === "w1");
});

test("event queue backs off, fails after MAX_ATTEMPTS and requeues after a restart", () => {
  const db = new CoordinationDb(":memory:", undefined, [10, 10]);
  const ev = db.enqueue("w1", "turn", { n: 1 }, 1_000);
  db.markSending(ev.id);
  let now = 1_000;
  for (let i = 0; i < 5; i++) {
    const state = db.markFailed(ev.id, `boom-${i}`, now);
    const pending = db.nextEventFor("w1", now + 100_000);
    if (i < 4) {
      assert.equal(state, "pending");
      assert.ok(pending.due, "due again after backoff");
      now = 1_000 + 10 * (i + 2) * 10_000;
    } else {
      assert.equal(state, "failed");
      assert.ok(!db.nextEventFor("w1", now).due);
    }
  }
  const ev2 = db.enqueue("w1", "turn", {}, 1_000);
  db.markSending(ev2.id);
  assert.equal(db.requeueInterrupted(), 1);
  assert.ok(db.nextEventFor("w1", 1_000).due);
});

test("AC-S1.2 / AC-S1.3 mid-turn delivery exactly once; channel at turn start", async () => {
  const db = freshDb();
  db.boardWrite({ thread_id: "w1", type: "CLAIM", content: "own parser", work_label: "parser" });
  db.sendMessage({ from: "w1", to: "w2", body: "collision on parser" });
  db.sendMessage({ from: "harness", body: "team note" });
  const tools = createBoardTools({ db, runId: "r", workerId: "w2", requestMerge: async () => { throw new Error("not in this test"); }, onClaim: async () => "" });
  const read = await tools.find((t) => t.name === "board_read")!.run({}, {} as never);
  assert.ok(read.content.includes("=== NEW SINCE YOUR LAST READ ==="), "delivery block appended");
  assert.ok(read.content.includes("[DM from w1] collision on parser"), "DM rides the tool result");
  assert.ok(!read.content.includes("team note"), "channel is NOT delivered mid-turn");
  const again = await tools.find((t) => t.name === "board_read")!.run({}, {} as never);
  assert.ok(!again.content.includes("collision on parser"), "delivered exactly once");
  // Channel drains at turn start and does not move the DM cursor.
  const ch = db.drainChannel("w2");
  assert.deepEqual(ch.map((m) => m.body), ["team note"]);
  assert.equal(db.drainChannel("w2").length, 0);
});

test("AC-S1.1 CLAIM via board_write triggers the engine branch switch and applies the run's claim TTL", async () => {
  const db = freshDb();
  let switched = "";
  let ttlSeen: number | undefined;
  const tools = createBoardTools({
    db, runId: "r", workerId: "w1", claimTtlSeconds: 1_200,
    requestMerge: async () => { throw new Error("not in this test"); },
    onClaim: async (label) => { switched = label; return `switched to ${label}`; },
  });
  const noLabel = await tools.find((t) => t.name === "board_write")!.run({ type: "CLAIM", content: "x" }, {} as never);
  assert.equal(noLabel.ok, false, "CLAIM without work_label refused");
  // TTL observation: capture the inserted row's expires_at - ts == 1200.
  const ok = await tools.find((t) => t.name === "board_write")!.run({ type: "CLAIM", content: "own parser", work_label: "My Parser!" }, {} as never);
  assert.equal(ok.ok, true);
  assert.equal(switched, "my-parser", "label normalized for the branch switch");
  const row = db.entries().find((e) => e.type === "CLAIM")!;
  ttlSeen = (row.expires_at ?? 0) - row.ts;
  assert.equal(ttlSeen, 1_200);
});

test("AC-S1.4 the worker registry holds the confined Loam tools plus board tools, nothing else", () => {
  const db = freshDb();
  const tools = createBoardTools({ db, runId: "r", workerId: "w1", requestMerge: async () => { throw new Error("x"); }, onClaim: async () => "" });
  const reg = buildWorkerRegistry(baseTools(), tmpDir(), new AbortController().signal, tools, () => () => undefined);
  const names = new Set(reg.toOllama().map((t) => t.function.name));
  for (const n of ["file_read", "file_write", "git_commit", "shell_run", ...BOARD_TOOL_NAMES]) assert.ok(names.has(n), `${n} present`);
  assert.ok(!names.has("mirofish_run"), "the decoy never reaches a worker");
  assert.ok(!names.has("browser_open"), "no browser tool");
});
