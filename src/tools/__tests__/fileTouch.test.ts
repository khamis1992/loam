/**
 * Tests for cross-session file-touch notifications (jcode J8).
 *
 * Loam runs several agent sessions against one workspace (orchestrator workers,
 * sub-agents, swarm stages). When session A writes a file that session B has
 * already read, B's view of that file is stale, so B must be told at its next
 * turn: path, writer, and a short line-diff summary.
 *
 * Guarantees under test:
 *  - a reader of a path is notified when another session writes it
 *  - no notice for a path nobody read
 *  - no self-notice (a writer is never told about its own write)
 *  - a write that changes nothing produces no notice
 *  - a reader who re-reads the file after the edit is not notified again
 *  - repeated edits to the same path collapse into ONE pending notice
 *  - deleting a file notifies its readers that it is gone
 *  - `forgetSession` drops a finished session's queue and reader marks
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FileTouchRegistry, diffLines, formatDiffPreview, formatDiffSummary } from "../fileTouch.js";

let tmpDir = "";
let registry: FileTouchRegistry;
/** Distinct workspace roots per test keep the module-level registry map clean. */
const sessions = new Set<string>();

function target(rel = "shared.ts"): string {
  return path.join(tmpDir, rel);
}

function id(name: string): string {
  sessions.add(name);
  return name;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-filetouch-"));
  registry = new FileTouchRegistry(tmpDir);
});

afterEach(() => {
  for (const session of sessions) registry.forgetSession(session);
  sessions.clear();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("diffLines", () => {
  it("reports added and removed lines and keeps a short preview", () => {
    const diff = diffLines("alpha\nbeta\ngamma\n", "alpha\nBETA\ngamma\ndelta\n");
    assert.equal(diff.added, 2);
    assert.equal(diff.removed, 1);
    assert.deepEqual(diff.removedLines, ["beta"]);
    assert.deepEqual(diff.addedLines, ["BETA", "delta"]);
    assert.equal(formatDiffSummary(diff), "+2/-1");
    assert.deepEqual(formatDiffPreview(diff), ["- beta", "+ BETA", "+ delta"]);
  });

  it("treats identical content as no change", () => {
    const diff = diffLines("same\n", "same\n");
    assert.equal(diff.added, 0);
    assert.equal(diff.removed, 0);
    assert.deepEqual(formatDiffPreview(diff), []);
  });

  it("falls back to a multiset count for very large files", () => {
    const a = Array.from({ length: 500 }, (_, i) => `line-${i}`).join("\n");
    const b = a + "\nextra";
    const diff = diffLines(a, b);
    assert.equal(diff.added, 1);
    assert.equal(diff.removed, 0);
  });
});

describe("file touch registry", () => {
  it("notifies a reader when another session writes a file it read", () => {
    fs.writeFileSync(target(), "alpha\nbeta\n", "utf8");
    registry.noteRead(id("session-b"), target(), "alpha\nbeta\n");

    const produced = registry.noteWrite(id("session-a"), target(), "alpha\nBETA\ngamma\n");

    assert.equal(produced.length, 1);
    assert.equal(produced[0]!.writer, "session-a");
    assert.equal(produced[0]!.summary, "+2/-1");
    assert.deepEqual(produced[0]!.preview, ["- beta", "+ BETA", "+ gamma"]);

    const queued = registry.drainNotices("session-b");
    assert.equal(queued.length, 1, "B must receive the notice");
    assert.equal(queued[0]!.relPath, "shared.ts");
    assert.equal(registry.pendingCount("session-b"), 0, "draining clears the queue");
  });

  it("sends no notice for a file nobody read", () => {
    fs.writeFileSync(target("unread.ts"), "alpha\n", "utf8");
    const produced = registry.noteWrite(id("session-a"), target("unread.ts"), "beta\n");
    assert.equal(produced.length, 0);
    assert.equal(registry.drainNotices("session-b").length, 0);
  });

  it("never notifies the writer about its own write", () => {
    fs.writeFileSync(target(), "alpha\n", "utf8");
    registry.noteRead(id("session-a"), target(), "alpha\n");
    const produced = registry.noteWrite(id("session-a"), target(), "beta\n");
    assert.equal(produced.length, 0);
    assert.equal(registry.drainNotices("session-a").length, 0);
  });

  it("sends no notice when the write changes nothing", () => {
    fs.writeFileSync(target(), "alpha\n", "utf8");
    registry.noteRead(id("session-b"), target(), "alpha\n");
    const produced = registry.noteWrite(id("session-a"), target(), "alpha\n");
    assert.equal(produced.length, 0);
    assert.equal(registry.drainNotices("session-b").length, 0);
  });

  it("does not notify a reader who re-read the file after the edit", () => {
    fs.writeFileSync(target(), "alpha\n", "utf8");
    registry.noteRead(id("session-b"), target(), "alpha\n");
    registry.noteWrite(id("session-a"), target(), "beta\n");
    // B catches up and re-reads before its next turn.
    registry.noteRead(id("session-b"), target(), "beta\n");
    assert.equal(registry.drainNotices("session-b").length, 0);
  });

  it("collapses repeated edits to one path into a single pending notice", () => {
    fs.writeFileSync(target(), "alpha\n", "utf8");
    registry.noteRead(id("session-b"), target(), "alpha\n");

    registry.noteWrite(id("session-a"), target(), "beta\n");
    registry.noteWrite(id("session-a"), target(), "beta\ngamma\n");
    registry.noteWrite(id("session-a"), target(), "beta\ngamma\ndelta\n");

    const queued = registry.drainNotices("session-b");
    assert.equal(queued.length, 1, "B must not be flooded");
    assert.equal(queued[0]!.edits, 3);
    assert.equal(queued[0]!.summary, "+3/-1");
  });

  it("notifies every reader but not the writer", () => {
    fs.writeFileSync(target(), "alpha\n", "utf8");
    registry.noteRead(id("session-b"), target(), "alpha\n");
    registry.noteRead(id("session-c"), target(), "alpha\n");

    const produced = registry.noteWrite(id("session-a"), target(), "beta\n");

    // One notice per other reader, and never one for the writer.
    assert.equal(produced.length, 2);
    assert.deepEqual(produced.map((n) => n.writer), ["session-a", "session-a"]);
    assert.equal(registry.drainNotices("session-b").length, 1);
    assert.equal(registry.drainNotices("session-c").length, 1);
    assert.equal(registry.drainNotices("session-a").length, 0);
  });

  it("tells readers when a file is deleted", () => {
    fs.writeFileSync(target(), "alpha\nbeta\n", "utf8");
    registry.noteRead(id("session-b"), target(), "alpha\nbeta\n");

    const produced = registry.noteDelete(id("session-a"), target());

    assert.equal(produced.length, 1);
    assert.equal(produced[0]!.summary, "file deleted");
    const queued = registry.drainNotices("session-b");
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.summary, "file deleted");
  });

  it("forgets a finished session's queue and reader marks", () => {
    fs.writeFileSync(target(), "alpha\n", "utf8");
    registry.noteRead(id("session-b"), target(), "alpha\n");
    registry.noteWrite(id("session-a"), target(), "beta\n");
    assert.equal(registry.pendingCount("session-b"), 1);

    registry.forgetSession("session-b");

    assert.equal(registry.pendingCount("session-b"), 0);
    // B's reader mark is gone, so a later write produces no notice for it.
    const produced = registry.noteWrite(id("session-a"), target(), "gamma\n");
    assert.equal(produced.length, 0);
  });

  it("keeps the per-session queue bounded", () => {
    for (let i = 0; i < 200; i++) {
      const file = target(`f${i}.ts`);
      fs.writeFileSync(file, "alpha\n", "utf8");
      registry.noteRead(id("session-b"), file, "alpha\n");
      registry.noteWrite(id("session-a"), file, "beta\n");
    }
    assert.ok(registry.pendingCount("session-b") <= 50);
  });
});
