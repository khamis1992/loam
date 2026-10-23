/**
 * Tests for the J3 edit-tool miss hints and post-edit context
 * (src/tools/files.ts, adapted from jcode's ref/edit.rs).
 *
 * Guarantees under test:
 *  - file_edit rejects an empty old_string, old==new, and a non-unique match
 *    unless replace_all, with a message that names the count and the options
 *  - on a miss the error hints when the text was found after trimming
 *    whitespace, and hints the 1-based line when it was found with different
 *    indentation, otherwise it is a plain not-found (never a fuzzy apply)
 *  - replace_all replaces every occurrence
 *  - the `edits[]` batch is validated atomically (all-or-nothing) and reports
 *    every failure
 *  - a successful edit returns a line-numbered snippet around the change
 *  - the pure helpers behave the same way they do through the tool
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  applyEditOperations,
  extractContext,
  fileTools,
  findLineNumber,
  flexibleMatchHint,
  type EditOperation,
} from "../files.js";
import type { Tool, ToolContext } from "../registry.js";

let tmpDir = "";
let file = "";
let ctx: ToolContext;

function edit(): Tool {
  const tool = fileTools.find((t) => t.name === "file_edit");
  assert.ok(tool, "file_edit tool is exported");
  return tool;
}

function run(args: Record<string, unknown>) {
  return edit().run(args, ctx);
}

function op(oldString: string, newString: string, replaceAll = false): EditOperation {
  return { oldString, newString, replaceAll };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-edithints-"));
  file = path.join(tmpDir, "sample.txt");
  ctx = { cfg: {} as never, workspace: tmpDir, emit: () => {} };
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("file_edit validation", () => {
  it("rejects an empty old_string without writing", async () => {
    fs.writeFileSync(file, "alpha\n", "utf8");
    const res = await run({ path: "sample.txt", old_string: "", new_string: "x" });
    assert.equal(res.ok, false);
    assert.match(res.content, /non-empty/i);
    assert.equal(fs.readFileSync(file, "utf8"), "alpha\n");
  });

  it("rejects a no-op edit when old_string equals new_string", async () => {
    fs.writeFileSync(file, "alpha\n", "utf8");
    const res = await run({ path: "sample.txt", old_string: "alpha", new_string: "alpha" });
    assert.equal(res.ok, false);
    assert.match(res.content, /identical/i);
    assert.equal(fs.readFileSync(file, "utf8"), "alpha\n");
  });

  it("rejects a non-unique match unless replace_all, naming the count", async () => {
    fs.writeFileSync(file, "x\nx\n", "utf8");
    const res = await run({ path: "sample.txt", old_string: "x", new_string: "y" });
    assert.equal(res.ok, false);
    assert.match(res.content, /found 2 times/i);
    assert.match(res.content, /Provide more context/i);
    assert.match(res.content, /replace_all/);
    assert.equal(fs.readFileSync(file, "utf8"), "x\nx\n");
  });

  it("replaces every occurrence with replace_all", async () => {
    fs.writeFileSync(file, "x\nx\nx\n", "utf8");
    const res = await run({ path: "sample.txt", old_string: "x", new_string: "y", replace_all: true });
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), "y\ny\ny\n");
    assert.match(res.content, /replaced 3 occurrence/);
  });
});

describe("file_edit miss hints", () => {
  it("hints when the text is found after trimming whitespace", async () => {
    fs.writeFileSync(file, "alpha\n  beta\n", "utf8");
    const res = await run({ path: "sample.txt", old_string: "beta  \n", new_string: "BETA" });
    assert.equal(res.ok, false);
    assert.match(res.content, /trimming whitespace/i);
    assert.equal(fs.readFileSync(file, "utf8"), "alpha\n  beta\n");
  });

  it("hints the 1-based line when only the indentation differs", async () => {
    fs.writeFileSync(file, "one\ntwo\n    target\n    three\n", "utf8");
    const res = await run({
      path: "sample.txt",
      old_string: "target\nthree",
      new_string: "TARGET\nTHREE",
    });
    assert.equal(res.ok, false);
    assert.match(res.content, /different indentation around line 3/i);
    assert.equal(fs.readFileSync(file, "utf8"), "one\ntwo\n    target\n    three\n");
  });

  it("falls back to a plain not-found that names the file", async () => {
    fs.writeFileSync(file, "alpha\n", "utf8");
    const res = await run({ path: "sample.txt", old_string: "zzz", new_string: "y" });
    assert.equal(res.ok, false);
    assert.match(res.content, /old_string not found in/i);
    assert.match(res.content, /file_read/i);
    assert.equal(fs.readFileSync(file, "utf8"), "alpha\n");
  });
});

describe("file_edit batch (edits[])", () => {
  it("applies an ordered batch in one atomic write", async () => {
    fs.writeFileSync(file, "alpha\nbeta\ngamma\n", "utf8");
    const res = await run({
      path: "sample.txt",
      edits: [
        { old_string: "alpha", new_string: "ALPHA" },
        { old_string: "beta", new_string: "BETA" },
      ],
    });
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), "ALPHA\nBETA\ngamma\n");
    assert.match(res.content, /applied 2 edit\(s\)/);
  });

  it("is all-or-nothing and reports every failure", async () => {
    fs.writeFileSync(file, "alpha\nbeta\n", "utf8");
    const res = await run({
      path: "sample.txt",
      edits: [
        { old_string: "alpha", new_string: "A" },
        { old_string: "missing", new_string: "M" },
        { old_string: "also missing", new_string: "N" },
        { old_string: "beta", new_string: "B" },
      ],
    });
    assert.equal(res.ok, false);
    assert.match(res.content, /No changes written/i);
    assert.match(res.content, /2 of 4 edits failed/i);
    assert.match(res.content, /Edit 2: old_string not found/i);
    assert.match(res.content, /Edit 3: old_string not found/i);
    assert.equal(fs.readFileSync(file, "utf8"), "alpha\nbeta\n", "nothing is written when any edit fails");
  });

  it("reports a miss hint inside the batch", async () => {
    fs.writeFileSync(file, "    target\n    beta\n", "utf8");
    const res = await run({
      path: "sample.txt",
      edits: [
        { old_string: "target\nbeta", new_string: "T\nB" },
        { old_string: "absent", new_string: "X" },
      ],
    });
    assert.equal(res.ok, false);
    assert.match(res.content, /Edit 1: .*different indentation around line 1/i);
    assert.match(res.content, /Edit 2: old_string not found/i);
    assert.equal(fs.readFileSync(file, "utf8"), "    target\n    beta\n");
  });

  it("rejects mixing edits with the single-edit shorthand", async () => {
    fs.writeFileSync(file, "alpha\n", "utf8");
    const res = await run({
      path: "sample.txt",
      edits: [{ old_string: "alpha", new_string: "A" }],
      old_string: "alpha",
      new_string: "A",
    });
    assert.equal(res.ok, false);
    assert.match(res.content, /not both/i);
    assert.equal(fs.readFileSync(file, "utf8"), "alpha\n");
  });

  it("rejects an empty or oversized batch", async () => {
    fs.writeFileSync(file, "alpha\n", "utf8");
    assert.equal((await run({ path: "sample.txt", edits: [] })).ok, false);
    const tooMany = Array.from({ length: 51 }, () => ({ old_string: "alpha", new_string: "A" }));
    const res = await run({ path: "sample.txt", edits: tooMany });
    assert.equal(res.ok, false);
    assert.match(res.content, /between 1 and 50/i);
    assert.equal(fs.readFileSync(file, "utf8"), "alpha\n");
  });
});

describe("file_edit post-edit snippet", () => {
  it("returns a line-numbered snippet around a single edit", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    lines[9] = "target";
    fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");

    const res = await run({ path: "sample.txt", old_string: "target", new_string: "TARGET" });
    assert.equal(res.ok, true);
    assert.match(res.content, /Context after edit \(lines 7-13\)/);
    assert.match(res.content, /^\s*7\| line 7$/m);
    assert.match(res.content, /^\s*10\| TARGET$/m);
    assert.match(res.content, /^\s*13\| line 13$/m);
    assert.doesNotMatch(res.content, /^\s*6\|/m);
    assert.doesNotMatch(res.content, /^\s*14\|/m);
  });

  it("clamps the snippet at the start and end of the file", async () => {
    fs.writeFileSync(file, "first\nsecond\n", "utf8");
    const res = await run({ path: "sample.txt", old_string: "first", new_string: "FIRST" });
    assert.equal(res.ok, true);
    assert.match(res.content, /Context after edit \(lines 1-3\)/);
    assert.match(res.content, /^\s*1\| FIRST$/m);
  });

  it("shows a snippet per edit in a batch", async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    lines[1] = "alpha";
    lines[9] = "beta";
    fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");

    const res = await run({
      path: "sample.txt",
      edits: [
        { old_string: "alpha", new_string: "ALPHA" },
        { old_string: "beta", new_string: "BETA" },
      ],
    });
    assert.equal(res.ok, true);
    assert.match(res.content, /Context after edit 1 \(lines 1-5\)/);
    assert.match(res.content, /^\s*2\| ALPHA$/m);
    // The trailing newline adds a 13th (empty) line, so the clamp reaches 13.
    assert.match(res.content, /Context after edit 2 \(lines 7-13\)/);
    assert.match(res.content, /^\s*10\| BETA$/m);
  });
});

describe("edit helper functions", () => {
  it("findLineNumber counts 1-based lines on the first match", () => {
    const content = "line 1\nline 2\nline 3\n";
    assert.equal(findLineNumber(content, "line 1"), 1);
    assert.equal(findLineNumber(content, "line 3"), 3);
    assert.equal(findLineNumber(content, "absent"), 1);
  });

  it("extractContext clamps to the file bounds", () => {
    // A trailing newline yields a 6th (empty) line, which the clamp includes.
    const content = "a\nb\nc\nd\ne\n";
    assert.equal(content.split("\n").length, 6);
    assert.deepEqual(extractContext(content, 3, 3, 3), {
      startLine: 1,
      endLine: 6,
      text: ["   1| a", "   2| b", "   3| c", "   4| d", "   5| e", "   6| "].join("\n"),
    });
    const end = extractContext(content, 5, 5, 3);
    assert.equal(end.endLine, 6);
    assert.ok(end.text.includes("   6| "));
  });

  it("flexibleMatchHint prefers the trim hint over the indent hint", () => {
    const trim = flexibleMatchHint("alpha\n  beta\n", "beta  \n", "f");
    assert.match(trim, /trimming whitespace/i);
    const indent = flexibleMatchHint("    target\n    three\n", "target\nthree", "f");
    assert.match(indent, /different indentation around line 1/i);
    const plain = flexibleMatchHint("alpha\n", "zzz", "f.txt");
    assert.match(plain, /old_string not found in f\.txt/);
  });

  it("applyEditOperations applies edits sequentially and reports misses", () => {
    const ok = applyEditOperations("alpha\nbeta\n", [op("alpha", "temp"), op("temp", "done"), op("beta", "b")], "f");
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.content, "done\nb\n");

    const bad = applyEditOperations("alpha\n", [op("alpha", "A"), op("missing", "M"), op("alpha", "B")], "f");
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.failures.join("\n"), /Edit 2: old_string not found/);
  });

  it("applyEditOperations rejects ambiguity unless replace_all is set", () => {
    const bad = applyEditOperations("x x", [op("x", "y")], "f");
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.failures[0]!, /found 2 times/);

    const good = applyEditOperations("x x", [op("x", "y", true)], "f");
    assert.equal(good.ok, true);
    if (good.ok) assert.equal(good.content, "y y");
  });

  // The spec substitutes new_string verbatim (Rust `replacen`). JS
  // `String.prototype.replace` would expand `$&`, `` $` ``, `$'` and `$$`, so
  // these pin the literal behaviour a shell/regex-shaped replacement would break.
  it("writes a new_string containing $ patterns literally", () => {
    const patterns = [
      ["price", "cost $5"],
      ["price", "a $& b"],
      ["price", "$`"],
      ["price", "$'"],
      ["price", "$$"],
      ["price", "$1 $2"],
    ] as const;
    for (const [find, replacement] of patterns) {
      const res = applyEditOperations(`line: ${find}\n`, [op(find, replacement)], "f");
      assert.equal(res.ok, true, `replace ${JSON.stringify(replacement)}`);
      if (res.ok) assert.equal(res.content, `line: ${replacement}\n`);
    }
  });

  it("writes $ patterns literally through the tool and in a batch", async () => {
    fs.writeFileSync(file, "alpha\nbeta\n", "utf8");
    const single = await run({ path: "sample.txt", old_string: "alpha", new_string: "a $$ b $& c" });
    assert.equal(single.ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), "a $$ b $& c\nbeta\n");

    fs.writeFileSync(file, "alpha\nbeta\n", "utf8");
    const batch = await run({
      path: "sample.txt",
      edits: [
        { old_string: "alpha", new_string: "x $1" },
        { old_string: "beta", new_string: "$& y" },
      ],
    });
    assert.equal(batch.ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), "x $1\n$& y\n");
  });

  it("does not treat a trailing newline in new_string as an extra line", () => {
    // Mirrors the spec: end_line = start_line + new_string.lines().count() - 1,
    // and Rust's `lines()` does not count a trailing newline as a new line.
    const res = applyEditOperations("one\ntwo\nthree\n", [op("two\n", "TWO\n")], "f");
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.applied, [{ occurrences: 1, startLine: 2, endLine: 2 }]);

    const multi = applyEditOperations("one\ntwo\n", [op("one", "A\nB")], "f");
    assert.equal(multi.ok, true);
    if (multi.ok) assert.deepEqual(multi.applied, [{ occurrences: 1, startLine: 1, endLine: 2 }]);
  });
});
