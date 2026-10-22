/**
 * Tests for file_multi_edit (multiEdit.ts).
 *
 * Guarantees under test:
 *  - multiple edits apply sequentially in one atomic write
 *  - ambiguous or missing find text fails without touching the file
 *  - replaceAll replaces every occurrence
 *  - CRLF line endings and BOM are preserved
 *  - paths outside the workspace are rejected
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createMultiEditTools } from "../multiEdit.js";

let tmpDir = "";
let file = "";

function tool() {
  const found = createMultiEditTools().find((t) => t.name === "file_multi_edit");
  assert.ok(found, "file_multi_edit tool is exported");
  return found;
}

function run(args: Record<string, unknown>) {
  return tool().run(args, { cfg: {} as never, workspace: tmpDir, emit: () => {} });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-multiedit-"));
  file = path.join(tmpDir, "sample.txt");
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("file_multi_edit", () => {
  it("applies multiple edits in one atomic write", async () => {
    fs.writeFileSync(file, "alpha\nbeta\ngamma\n", "utf8");
    const res = await run({
      path: "sample.txt",
      edits: [
        { find: "alpha", replace: "ALPHA" },
        { find: "beta", replace: "BETA" },
      ],
    });
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), "ALPHA\nBETA\ngamma\n");
    assert.match(res.content, /applied 2 edit\(s\)/);
    assert.match(res.content, /\+\d+ -\d+/);
    assert.match(res.content, /@@ -/);
  });

  it("rejects an ambiguous find and leaves the file untouched", async () => {
    fs.writeFileSync(file, "x\nx\n", "utf8");
    const before = fs.readFileSync(file, "utf8");
    const res = await run({ path: "sample.txt", edits: [{ find: "x", replace: "y" }] });
    assert.equal(res.ok, false);
    assert.match(res.content, /ambiguous/i);
    assert.match(res.content, /2 matches/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });

  it("rejects a missing find and leaves the file untouched", async () => {
    fs.writeFileSync(file, "hello\n", "utf8");
    const before = fs.readFileSync(file, "utf8");
    const res = await run({ path: "sample.txt", edits: [{ find: "zzz", replace: "y" }] });
    assert.equal(res.ok, false);
    assert.match(res.content, /not found/i);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });

  it("a failing later edit discards all earlier edits", async () => {
    fs.writeFileSync(file, "alpha\nbeta\n", "utf8");
    const res = await run({
      path: "sample.txt",
      edits: [
        { find: "alpha", replace: "A" },
        { find: "missing", replace: "M" },
      ],
    });
    assert.equal(res.ok, false);
    assert.match(res.content, /edit 2/);
    assert.equal(fs.readFileSync(file, "utf8"), "alpha\nbeta\n");
  });

  it("replaceAll replaces every occurrence", async () => {
    fs.writeFileSync(file, "a a a\n", "utf8");
    const res = await run({ path: "sample.txt", edits: [{ find: "a", replace: "b", replaceAll: true }] });
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), "b b b\n");
  });

  it("preserves CRLF line endings", async () => {
    fs.writeFileSync(file, "one\r\ntwo\r\n", "utf8");
    const res = await run({ path: "sample.txt", edits: [{ find: "two", replace: "TWO" }] });
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), "one\r\nTWO\r\n");
  });

  it("preserves a UTF-8 BOM", async () => {
    fs.writeFileSync(file, "\uFEFFalpha\nbeta\n", "utf8");
    const res = await run({ path: "sample.txt", edits: [{ find: "alpha", replace: "ALPHA" }] });
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), "\uFEFFALPHA\nbeta\n");
  });

  it("rejects paths outside the workspace", async () => {
    for (const bad of ["../escape.txt", "..\\escape.txt", path.join(os.tmpdir(), "outside.txt")]) {
      const res = await run({ path: bad, edits: [{ find: "a", replace: "b" }] });
      assert.equal(res.ok, false, `expected refusal for ${bad}`);
      assert.match(res.content, /outside workspace|path outside/i);
    }
  });

  it("validates the edits array", async () => {
    fs.writeFileSync(file, "hello\n", "utf8");
    assert.equal((await run({ path: "sample.txt", edits: [] })).ok, false);
    const tooMany = Array.from({ length: 51 }, () => ({ find: "a", replace: "b" }));
    assert.equal((await run({ path: "sample.txt", edits: tooMany })).ok, false);
    assert.equal((await run({ path: "sample.txt", edits: [{ find: "", replace: "b" }] })).ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), "hello\n");
  });

  it("reports not found for a missing file", async () => {
    const res = await run({ path: "nope.txt", edits: [{ find: "a", replace: "b" }] });
    assert.equal(res.ok, false);
    assert.match(res.content, /not found/i);
  });
});
