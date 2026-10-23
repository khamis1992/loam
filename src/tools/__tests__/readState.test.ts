/**
 * Tests for the read-tracking guard (readState.ts + its wiring in files.ts and
 * multiEdit.ts).
 *
 * Guarantees under test:
 *  - file_edit / file_multi_edit reject an existing file that was never read
 *    with a NOT_READ code and an actionable message
 *  - touching a file after it was read makes the next edit fail with STALE
 *  - creating a brand-new file with file_write is always allowed
 *  - re-reading the file refreshes the snapshot so an edit then succeeds
 *  - a successful edit refreshes the snapshot so consecutive edits are allowed
 *  - a run context without a ReadState (isolated verifier / unit test) skips
 *    the guard entirely
 *  - reads, writes, and deletes are published to the cross-session touch hooks
 *    (jcode J8), so another live session can be told the file changed
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Config } from "../../config.js";
import type { Emit } from "../../agent/events.js";
import type { ToolContext } from "../registry.js";
import { fileTools } from "../files.js";
import { createMultiEditTools } from "../multiEdit.js";
import { ReadState } from "../readState.js";

let tmpDir = "";
let readState: ReadState;
let ctx: ToolContext;

function findTool(name: string) {
  const all = [...fileTools, ...createMultiEditTools()];
  const tool = all.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} is exported`);
  return tool;
}

function run(name: string, args: Record<string, unknown>) {
  return findTool(name).run(args, ctx);
}

function target(rel = "sample.txt"): string {
  return path.join(tmpDir, rel);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-readstate-"));
  readState = new ReadState();
  ctx = { cfg: { policy: { allowOutsideWorkspaceRead: false } } as Config, workspace: tmpDir, emit: (() => {}) as Emit, readState };
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("read-tracking guard", () => {
  it("rejects editing an existing file that was never read (NOT_READ)", async () => {
    fs.writeFileSync(target(), "alpha\nbeta\n", "utf8");
    const res = await run("file_edit", { path: "sample.txt", find: "alpha", replace: "ALPHA" });
    assert.equal(res.ok, false);
    assert.match(res.content, /NOT_READ/);
    assert.match(res.content, /file_read/);
    assert.equal(fs.readFileSync(target(), "utf8"), "alpha\nbeta\n");
    const check = readState.check(target());
    assert.equal(check.ok, false);
    assert.equal(check.ok === false ? check.code : "", "NOT_READ");
  });

  it("rejects multi_edit on an existing file that was never read (NOT_READ)", async () => {
    fs.writeFileSync(target(), "alpha\nbeta\n", "utf8");
    const res = await run("file_multi_edit", { path: "sample.txt", edits: [{ find: "alpha", replace: "ALPHA" }] });
    assert.equal(res.ok, false);
    assert.match(res.content, /NOT_READ/);
    assert.equal(fs.readFileSync(target(), "utf8"), "alpha\nbeta\n");
  });

  it("rejects an edit after the file changed on disk since it was read (STALE)", async () => {
    fs.writeFileSync(target(), "alpha\nbeta\n", "utf8");
    assert.equal((await run("file_read", { path: "sample.txt" })).ok, true);
    assert.equal(readState.check(target()).ok, true);

    // Simulate an external writer (user, linter, another process) touching the file.
    fs.appendFileSync(target(), "gamma\n", "utf8");

    const res = await run("file_edit", { path: "sample.txt", find: "alpha", replace: "ALPHA" });
    assert.equal(res.ok, false);
    assert.match(res.content, /STALE/);
    assert.match(res.content, /changed on disk/);
    assert.equal(fs.readFileSync(target(), "utf8"), "alpha\nbeta\ngamma\n");
    const check = readState.check(target());
    assert.equal(check.ok, false);
    assert.equal(check.ok === false ? check.code : "", "STALE");
  });

  it("allows creating a brand-new file with file_write", async () => {
    const res = await run("file_write", { path: "brand-new.txt", content: "hello\n" });
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(target("brand-new.txt"), "utf8"), "hello\n");
    assert.equal(readState.hasRead(target("brand-new.txt")), true);
  });

  it("allows editing a file after it has been read", async () => {
    fs.writeFileSync(target(), "alpha\nbeta\n", "utf8");
    assert.equal((await run("file_read", { path: "sample.txt" })).ok, true);
    const res = await run("file_edit", { path: "sample.txt", find: "beta", replace: "BETA" });
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(target(), "utf8"), "alpha\nBETA\n");
  });

  it("allows a second edit after a successful edit refreshed the snapshot", async () => {
    fs.writeFileSync(target(), "alpha\nbeta\n", "utf8");
    assert.equal((await run("file_read", { path: "sample.txt" })).ok, true);
    assert.equal((await run("file_edit", { path: "sample.txt", find: "alpha", replace: "ALPHA" })).ok, true);
    const second = await run("file_edit", { path: "sample.txt", find: "beta", replace: "BETA" });
    assert.equal(second.ok, true);
    assert.equal(fs.readFileSync(target(), "utf8"), "ALPHA\nBETA\n");
  });

  it("allows consecutive multi_edit calls after the first refreshed the snapshot", async () => {
    fs.writeFileSync(target(), "alpha\nbeta\n", "utf8");
    assert.equal((await run("file_read", { path: "sample.txt" })).ok, true);
    assert.equal((await run("file_multi_edit", { path: "sample.txt", edits: [{ find: "alpha", replace: "ALPHA" }] })).ok, true);
    const second = await run("file_multi_edit", { path: "sample.txt", edits: [{ find: "beta", replace: "BETA" }] });
    assert.equal(second.ok, true);
    assert.equal(fs.readFileSync(target(), "utf8"), "ALPHA\nBETA\n");
  });

  it("skips the guard when the run context carries no ReadState", async () => {
    fs.writeFileSync(target(), "alpha\n", "utf8");
    const bareCtx: ToolContext = { cfg: { policy: { allowOutsideWorkspaceRead: false } } as Config, workspace: tmpDir, emit: (() => {}) as Emit };
    const res = await findTool("file_edit").run({ path: "sample.txt", find: "alpha", replace: "ALPHA" }, bareCtx);
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(target(), "utf8"), "ALPHA\n");
  });

  it("re-reading after an external change clears the stale state", async () => {
    fs.writeFileSync(target(), "alpha\n", "utf8");
    assert.equal((await run("file_read", { path: "sample.txt" })).ok, true);
    fs.appendFileSync(target(), "beta\n", "utf8");
    assert.equal((await run("file_edit", { path: "sample.txt", find: "alpha", replace: "ALPHA" })).ok, false);
    assert.equal((await run("file_read", { path: "sample.txt" })).ok, true);
    const res = await run("file_edit", { path: "sample.txt", find: "beta", replace: "BETA" });
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(target(), "utf8"), "alpha\nBETA\n");
  });
});

describe("cross-session touch hooks (jcode J8)", () => {
  it("publishes read, write, and remove with the content each one saw", async () => {
    fs.writeFileSync(target(), "alpha\n", "utf8");
    const events: string[] = [];
    readState.hooks = {
      read: (abs, content) => events.push(`read:${path.basename(abs)}:${content}`),
      write: (abs, content) => events.push(`write:${path.basename(abs)}:${content}`),
      remove: (abs) => events.push(`remove:${path.basename(abs)}`),
    };

    await run("file_read", { path: "sample.txt" });
    await run("file_edit", { path: "sample.txt", find: "alpha", replace: "ALPHA" });
    await run("file_write", { path: "sample.txt", content: "ALPHA\nBETA\n" });
    await run("file_delete", { path: "sample.txt" });

    // A read reports the exact content seen; a write reports the new content;
    // a delete reports the path that is gone. The loop uses these to tell other
    // live sessions that this file changed.
    assert.deepEqual(events, [
      "read:sample.txt:alpha\n",
      "write:sample.txt:ALPHA\n",
      "write:sample.txt:ALPHA\nBETA\n",
      "remove:sample.txt",
    ]);
  });

  it("forgets a moved file and publishes the new path as a write", async () => {
    fs.writeFileSync(target(), "alpha\n", "utf8");
    const events: string[] = [];
    readState.hooks = {
      write: (abs) => events.push(`write:${path.basename(abs)}`),
      remove: (abs) => events.push(`remove:${path.basename(abs)}`),
    };

    await run("file_move", { from: "sample.txt", to: "moved.txt" });

    assert.deepEqual(events, ["remove:sample.txt", "write:moved.txt"]);
  });
});
