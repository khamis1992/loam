/**
 * Focused unit tests for the agentic text-driven video edit compiler
 * (src/tools/videoEditAgent.ts). Pure compiler behaviour plus the
 * workspace-side EDL loader; no ffmpeg, no network, no task database.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";

import {
  compileEdl,
  computeSegments,
  parseTimeToken,
  createWorkspaceTimelineService,
} from "../videoEditAgent.js";

let tmpDir = "";
after(() => {
  try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup raced */ }
});

function freshWorkspace(): string {
  if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-videoedit-pure-"));
  return fs.mkdtempSync(path.join(tmpDir, "ws-"));
}

describe("compileEdl hardening", () => {
  it("reuses a saved EDL's duration when the probe returns none", () => {
    const previous = compileEdl({ instruction: "trim 0 to 20, split at 10", sourcePath: "v.mp4", durationSec: 60 });
    assert.equal(previous.source.durationSec, 60);
    assert.equal(computeSegments(previous.ops, 60)!.length, 2);
    const next = compileEdl({ instruction: "move segment 2 to position 1", sourcePath: "v.mp4", previous });
    // Without the fallback the reorder is skipped because duration is unknown.
    assert.deepEqual(next.ops.map((o) => o.op), ["trim", "split", "reorder"]);
    assert.deepEqual(next.ops[2], { id: "op3", op: "reorder", order: [2, 1] });
    assert.equal(next.warnings.length, 0);
  });

  it("rejects a reorder that does not name every surviving segment", () => {
    const edl = compileEdl({ instruction: "reorder 1 2", sourcePath: "v.mp4", durationSec: 10 });
    assert.equal(edl.ops.length, 0, "a 2-index permutation over 1 segment is not a no-op");
    assert.ok(edl.warnings.some((w) => w.includes("full permutation")));
  });

  it("accepts a full permutation and moves a segment", () => {
    const splitFirst = compileEdl({ instruction: "split at 5s", sourcePath: "v.mp4", durationSec: 10 });
    const edl = compileEdl({ instruction: "reorder 2 1", sourcePath: "v.mp4", durationSec: 10, previous: splitFirst });
    assert.deepEqual(edl.ops.map((o) => o.op), ["split", "reorder"]);
    assert.deepEqual(edl.ops[1], { id: "op2", op: "reorder", order: [2, 1] });
    assert.deepEqual(computeSegments(edl.ops, 10), [{ fromSec: 5, toSec: 10 }, { fromSec: 0, toSec: 5 }]);
  });

  it("skips an overlay at or beyond the video end instead of emitting a zero-length one", () => {
    const atEnd = compileEdl({ instruction: 'add text "Hi" at 60s for 4s', sourcePath: "v.mp4", durationSec: 60 });
    assert.equal(atEnd.ops.length, 0);
    assert.ok(atEnd.warnings.some((w) => w.includes("at or beyond the video end")));

    const inside = compileEdl({ instruction: 'add text "Hi" at 59s for 4s', sourcePath: "v.mp4", durationSec: 60 });
    assert.deepEqual(inside.ops, [{ id: "op1", op: "overlay-text", text: "Hi", atSec: 59, durationSec: 1 }]);
  });

  it("clamps open-ended ranges and keeps one warning", () => {
    const edl = compileEdl({ instruction: "trim from 30 to the end", sourcePath: "v.mp4", durationSec: 60 });
    assert.deepEqual(edl.ops, [{ id: "op1", op: "trim", fromSec: 30, toSec: 60 }]);
    assert.equal(edl.warnings.length, 0);
  });
});

describe("computeSegments projection", () => {
  it("returns null when the duration is unknown or non-positive", () => {
    assert.equal(computeSegments([], undefined), null);
    assert.equal(computeSegments([], Number.NaN), null);
    assert.equal(computeSegments([], 0), null);
    assert.deepEqual(computeSegments([], 5), [{ fromSec: 0, toSec: 5 }]);
  });

  it("drops an out-of-range reorder instead of applying a partial order", () => {
    assert.deepEqual(computeSegments([{ id: "a", op: "reorder", order: [2, 1] }], 10), [{ fromSec: 0, toSec: 10 }]);
  });
});

describe("parseTimeToken", () => {
  it("parses clock, unit and plain forms and rejects junk", () => {
    assert.equal(parseTimeToken("1:02:03"), 3723);
    assert.equal(parseTimeToken("1:30"), 90);
    assert.equal(parseTimeToken("2m"), 120);
    assert.equal(parseTimeToken("1.5 sec"), 1.5);
    assert.equal(parseTimeToken("45"), 45);
    assert.equal(parseTimeToken("1:90"), null);
    assert.equal(parseTimeToken("-5"), null);
    assert.equal(parseTimeToken(""), null);
  });
});

describe("workspace EDL loader", () => {
  const EDL_LATEST = "uploads/loam-video-edl-latest.json";

  it("round-trips a valid saved EDL", async () => {
    const ws = freshWorkspace();
    const edl = compileEdl({ instruction: "delete 5s to 10s", sourcePath: "assets/v.mp4", durationSec: 60 });
    fs.mkdirSync(path.dirname(path.join(ws, EDL_LATEST)), { recursive: true });
    fs.writeFileSync(path.join(ws, EDL_LATEST), JSON.stringify(edl));
    const result = await createWorkspaceTimelineService().loadLatestEdl("task_x", ws);
    assert.ok(result);
    assert.deepEqual(result!.ops, edl.ops);
  });

  it("discards a corrupt EDL with unknown ops or malformed fields", async () => {
    const ws = freshWorkspace();
    fs.mkdirSync(path.dirname(path.join(ws, EDL_LATEST)), { recursive: true });
    const corrupt = { version: 1, source: { path: "assets/v.mp4" }, ops: [{ id: "op1", op: "explode" }], warnings: [], createdAt: "" };
    fs.writeFileSync(path.join(ws, EDL_LATEST), JSON.stringify(corrupt));
    const loaded = await createWorkspaceTimelineService().loadLatestEdl("task_x", ws);
    assert.equal(loaded, null);
  });

  it("returns null when no EDL has been saved yet", async () => {
    const loaded = await createWorkspaceTimelineService().loadLatestEdl("task_x", freshWorkspace());
    assert.equal(loaded, null);
  });

  it("ignores a malformed JSON sidecar without throwing", async () => {
    const ws = freshWorkspace();
    fs.mkdirSync(path.dirname(path.join(ws, EDL_LATEST)), { recursive: true });
    fs.writeFileSync(path.join(ws, EDL_LATEST), "{not json");
    const loaded = await createWorkspaceTimelineService().loadLatestEdl("task_x", ws);
    assert.equal(loaded, null);
  });
});
