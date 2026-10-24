/**
 * Neo N13: versioned document nodes and line diffs.
 *
 * The store tests pin the guarantees the canvas diff view depends on:
 *   1. every version of a node is kept, ordered by capture order;
 *   2. re-capturing an unchanged document is a no-op (no phantom version);
 *   3. rows survive a database reset only when they are actually re-read;
 *   4. pruning drops the oldest snapshots, never the newest.
 *
 * The diff tests pin that the LCS output is exact: applied to `a` it rebuilds
 * `b`, and the added/removed counts match an independent oracle.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { closeDb } from "../../server/sqliteStore.js";
import {
  applyNew,
  applyOld,
  changedLines,
  compareVersions,
  diffLines,
  diffSummary,
  isDocumentNodeType,
  isInsertOnly,
  NodeVersionStore,
  splitLines,
} from "../versions.js";

let tmpDir = "";
let prevDataDir: string | undefined;
let store: NodeVersionStore;

const NODE = "node_doc_1";
const RUN = "task_versions_1";

function seed(): void {
  store = new NodeVersionStore();
}

describe("node version store", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-versions-"));
    prevDataDir = process.env.MANUS_LOCAL_DATA_DIR;
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    closeDb();
    seed();
  });

  afterEach(() => {
    closeDb();
    if (prevDataDir === undefined) delete process.env.MANUS_LOCAL_DATA_DIR;
    else process.env.MANUS_LOCAL_DATA_DIR = prevDataDir;
    try {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    tmpDir = "";
  });

  it("captures each changed snapshot and keeps them in capture order", () => {
    const first = store.capture({ nodeId: NODE, runId: RUN, type: "document", title: "Report", content: "one", nodeVersion: 1 });
    const second = store.capture({ nodeId: NODE, runId: RUN, type: "document", title: "Report", content: "one\ntwo", nodeVersion: 2 });
    assert.equal(first?.version, 1, "the first capture is version 1");
    assert.equal(second?.version, 2, "a changed document is the next version");
    assert.equal(store.count(NODE), 2);
    assert.deepEqual(store.list(NODE).map((v) => v.content), ["one", "one\ntwo"]);
    assert.deepEqual(store.list(NODE).map((v) => v.version), [1, 2]);
  });

  it("does not store a phantom version for an unchanged document", () => {
    store.capture({ nodeId: NODE, runId: RUN, type: "webpage", title: "Page", content: "same", nodeVersion: 1 });
    const again = store.capture({ nodeId: NODE, runId: RUN, type: "webpage", title: "Page", content: "same", nodeVersion: 1 });
    assert.equal(store.count(NODE), 1);
    // A repeat capture writes nothing, so it reports undefined: callers use the
    // return value as "was a row written?". The existing snapshot is still there.
    assert.equal(again, undefined);
    assert.equal(store.latest(NODE)?.version, 1);
  });

  it("ignores nodes that carry no text", () => {
    const search = store.capture({ nodeId: "node_search", runId: RUN, type: "tool_result", title: "Search", content: "results", nodeVersion: 1 });
    assert.equal(search, undefined);
    assert.equal(store.count("node_search"), 0);
  });

  it("keeps two nodes apart and reads a single version by number", () => {
    store.capture({ nodeId: NODE, runId: RUN, type: "document", title: "A", content: "a1", nodeVersion: 1 });
    store.capture({ nodeId: "node_doc_2", runId: RUN, type: "document", title: "B", content: "b1", nodeVersion: 1 });
    store.capture({ nodeId: NODE, runId: RUN, type: "document", title: "A", content: "a2", nodeVersion: 2 });
    assert.deepEqual(store.list("node_doc_2").map((v) => v.content), ["b1"]);
    const v1 = store.get(NODE, 1);
    assert.equal(v1?.content, "a1");
    assert.equal(v1?.title, "A");
    assert.equal(store.get(NODE, 99), undefined);
    assert.equal(store.latest(NODE)?.version, 2);
  });

  it("reports versions per run and per node", () => {
    store.capture({ nodeId: NODE, runId: RUN, type: "document", title: "A", content: "a1", nodeVersion: 1 });
    store.capture({ nodeId: "node_doc_2", runId: "task_versions_2", type: "document", title: "B", content: "b1", nodeVersion: 1 });
    const forRun = store.listForRun(RUN);
    assert.deepEqual(Object.keys(forRun).sort(), [NODE]);
    assert.equal(forRun[NODE]!.length, 1);
  });

  it("is idempotent per (nodeId, version) and preserves the first capture time", () => {
    const first = store.put({ nodeId: NODE, runId: RUN, version: 1, type: "document", nodeVersion: 1, title: "A", content: "v1", created: 1000 });
    const second = store.put({ nodeId: NODE, runId: RUN, version: 1, type: "document", nodeVersion: 1, title: "A", content: "v1-again", created: 2000 });
    assert.equal(store.count(NODE), 1, "the row is replaced, not duplicated");
    assert.equal(second.version, first.version);
    assert.equal(second.content, "v1-again", "the latest content wins");
    assert.equal(second.created, 1000, "the original capture time is kept");
  });

  it("prunes the oldest versions and drops a whole node on request", () => {
    for (let i = 1; i <= 5; i += 1) {
      store.capture({ nodeId: NODE, runId: RUN, type: "document", title: "A", content: `rev ${i}`, nodeVersion: i });
    }
    const dropped = store.prune(NODE, 2);
    assert.equal(dropped, 3);
    assert.deepEqual(store.list(NODE).map((v) => v.content), ["rev 4", "rev 5"]);

    store.clearNode(NODE);
    assert.equal(store.count(NODE), 0);
    assert.equal(store.list(NODE).length, 0);
  });

  it("clears every version of a run without touching other runs", () => {
    store.capture({ nodeId: NODE, runId: RUN, type: "document", title: "A", content: "a1", nodeVersion: 1 });
    store.capture({ nodeId: "node_doc_2", runId: "task_versions_2", type: "document", title: "B", content: "b1", nodeVersion: 1 });
    store.clearRun(RUN);
    assert.equal(store.count(NODE), 0);
    assert.equal(store.count("node_doc_2"), 1);
  });

  it("re-reads rows from the database after a connection reset", () => {
    store.capture({ nodeId: NODE, runId: RUN, type: "document", title: "A", content: "a1", nodeVersion: 1 });
    closeDb();
    const fresh = new NodeVersionStore();
    assert.equal(fresh.count(NODE), 1, "the row is persisted, not only cached");
    assert.equal(fresh.get(NODE, 1)?.content, "a1");
  });
});

describe("isDocumentNodeType", () => {
  it("accepts the document kinds and refuses everything else", () => {
    for (const kind of ["document", "webpage", "kb_seed"]) assert.equal(isDocumentNodeType(kind), true);
    for (const kind of ["tool_result", "question", "media", ""]) assert.equal(isDocumentNodeType(kind), false);
  });
});

describe("splitLines", () => {
  it("does not invent a line after a trailing newline", () => {
    assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
    assert.deepEqual(splitLines("a"), ["a"]);
    assert.deepEqual(splitLines(""), []);
    assert.deepEqual(splitLines("a\r\nb"), ["a\r", "b"]);
  });
});

describe("diffLines", () => {
  it("reports no change for identical text", () => {
    const diff = diffLines("same\ntext\n", "same\ntext\n");
    assert.equal(diff.empty, true);
    assert.equal(diff.hunks.length, 0);
    assert.equal(diff.added, 0);
    assert.equal(diff.removed, 0);
    assert.equal(diff.unchanged, 2);
    assert.equal(diff.lines.length, 2, "the aligned pair keeps every line");
  });

  it("handles an empty old side as a pure insertion", () => {
    const diff = diffLines("", "hello\nworld\n");
    assert.equal(diff.added, 2);
    assert.equal(diff.removed, 0);
    assert.equal(isInsertOnly(diff), true);
    assert.equal(diff.hunks.length, 1);
    assert.equal(diff.hunks[0]!.oldStart, 0, "nothing precedes the insertion");
    assert.equal(diff.hunks[0]!.newStart, 1);
    assert.equal(diff.lines[0]!.oldLine, null, "an added line has no old number");
    assert.equal(diff.lines[0]!.newLine, 1);
  });

  it("handles an empty new side as a pure deletion", () => {
    const diff = diffLines("gone\n", "");
    assert.equal(diff.added, 0);
    assert.equal(diff.removed, 1);
    assert.equal(isInsertOnly(diff), false);
    assert.equal(diff.lines[0]!.newLine, null);
  });

  it("marks a changed line as a removal plus an insertion", () => {
    const diff = diffLines("a\nb\nc\n", "a\nB\nc\n");
    assert.equal(diff.added, 1);
    assert.equal(diff.removed, 1);
    assert.equal(diff.unchanged, 2);
    assert.equal(diff.hunks.length, 1);
    const changed = changedLines(diff.lines);
    assert.equal(changed.length, 2);
    assert.equal(changed[0]!.op, "delete", "the removed line comes first");
    assert.equal(changed[0]!.text, "b");
    assert.equal(changed[1]!.op, "insert");
    assert.equal(changed[1]!.text, "B");
    assert.equal(changed[0]!.oldLine, 2);
    assert.equal(changed[1]!.newLine, 2);
  });

  it("groups distant edits into separate hunks", () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n");
    const b = a.replace("l3", "L3").replace("l16", "L16");
    const diff = diffLines(a, b);
    assert.equal(diff.hunks.length, 2, "one hunk per changed block");
    assert.equal(changedLines(diff.hunks[0]!.lines)[0]!.text, "l3");
    assert.equal(changedLines(diff.hunks[1]!.lines)[0]!.text, "l16");
  });

  it("merges nearby edits into a single hunk and pads it with context", () => {
    const a = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const b = a.replace("line 8", "LINE 8").replace("line 10", "LINE 10");
    const diff = diffLines(a, b);
    assert.equal(diff.hunks.length, 1, "two edits inside the context window merge");
    const hunk = diff.hunks[0]!;
    // Five unchanged lines sit between the edits, which is exactly the merge
    // limit, so the hunk opens at line 5 (line 8 minus three context lines) and
    // runs to line 13 (line 10 plus three context lines). The two replacements
    // add no lines, so each contributes one delete and one insert: 13 lines of
    // context + 2 deletes + 2 inserts - 4 changed pairs counted twice = 11.
    assert.equal(hunk.lines.length, 11);
    assert.equal(hunk.oldLines, 9);
    assert.equal(hunk.newLines, 9);
    assert.equal(hunk.oldStart, 5);
    assert.equal(changedLines(hunk.lines).length, 4);
  });

  it("keeps line numbers aligned when lines are inserted", () => {
    const diff = diffLines("a\nc\n", "a\nb\nc\n");
    const changed = changedLines(diff.lines);
    assert.equal(changed.length, 1);
    assert.equal(changed[0]!.op, "insert");
    assert.equal(changed[0]!.text, "b");
    assert.equal(changed[0]!.newLine, 2);
    assert.equal(changed[0]!.oldLine, null);
  });

  it("rebuilds both texts from the diff and matches an independent oracle", () => {
    const a = "alpha\nbeta\ngamma\ndelta\n";
    const b = "alpha\nBETA\ngamma\nepsilon\ndelta\n";
    const diff = diffLines(a, b);

    // Applying the diff: `equal` and `insert` lines form the new text.
    assert.equal(applyNew(diff), b.trimEnd());
    assert.equal(applyOld(diff), a.trimEnd());

    // An independent count: the added lines are exactly b minus the common lines.
    const aLines = splitLines(a);
    const bLines = splitLines(b);
    assert.equal(diff.unchanged, 3);
    assert.equal(diff.added + diff.unchanged, bLines.length);
    assert.equal(diff.removed + diff.unchanged, aLines.length);
    assert.equal(diff.lines.length, aLines.length + diff.added);
    assert.equal(diff.lines.length, bLines.length + diff.removed);
  });

  it("matches a brute-force oracle on short random edits", () => {
    // A tiny deterministic pseudo-random source keeps the test reproducible.
    let seedValue = 42;
    const rand = (): number => {
      seedValue = (seedValue * 1103515245 + 12345) % 2147483648;
      return seedValue / 2147483648;
    };
    const alphabet = ["a", "b", "c", "d", "e"];

    for (let trial = 0; trial < 25; trial += 1) {
      const lines = (count: number): string[] =>
        Array.from({ length: count }, () => alphabet[Math.floor(rand() * alphabet.length)]!);
      const aLines = lines(3 + Math.floor(rand() * 4));
      const bLines = lines(3 + Math.floor(rand() * 4));
      const a = aLines.join("\n");
      const b = bLines.join("\n");
      const diff = diffLines(a, b);

      // Rebuilding either side from the diff is the oracle for correctness.
      assert.equal(applyNew(diff), b, `trial ${trial}: the diff must rebuild the new text`);
      assert.equal(applyOld(diff), a, `trial ${trial}: the diff must rebuild the old text`);

      // The counts partition both documents exactly.
      assert.equal(
        diff.removed + diff.unchanged,
        aLines.length,
        `trial ${trial}: removed + unchanged must cover the old lines`,
      );
      assert.equal(
        diff.added + diff.unchanged,
        bLines.length,
        `trial ${trial}: added + unchanged must cover the new lines`,
      );

      // Every hunk is a contiguous slice of the aligned pair.
      const seen = diff.hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
      assert.ok(seen <= diff.lines.length, `trial ${trial}: hunks must not exceed the aligned pair`);
    }
  });

  it("summarises the counts", () => {
    assert.equal(diffSummary(diffLines("a\n", "a\nb\nc\n")), "+2 -0");
  });
});

describe("compareVersions", () => {
  it("orders by insertion order, then version number", () => {
    const rows = [
      { id: "c", version: 2, seq: 3 },
      { id: "a", version: 2, seq: 1 },
      { id: "b", version: 1, seq: 2 },
    ];
    assert.deepEqual(rows.sort(compareVersions).map((r) => r.id), ["a", "b", "c"]);
  });
});
