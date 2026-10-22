/**
 * Tests for the edit-tool schema aliases (C2).
 *
 * Guarantees under test:
 *  - file_edit accepts the canonical `old_string`/`new_string` names
 *  - file_edit keeps `find`/`replace` as working aliases
 *  - file_edit replaces every occurrence when `replace_all` is true
 *  - file_edit rejects a no-op edit (old_string === new_string) with an error
 *  - file_edit's not-unique failure tells the model to add context
 *  - file_multi_edit accepts the same canonical names and aliases
 *  - the text_editor spec alias forwards both spellings to file_edit
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { ToolRegistry } from "../registry.js";
import { fileTools } from "../files.js";
import { createMultiEditTools } from "../multiEdit.js";
import { createSpecAliasTools } from "../specAliases.js";
import type { Tool, ToolContext, ToolResult } from "../registry.js";

let tmpDir = "";
let file = "";
let ctx: ToolContext;

function findTool(name: string): Tool {
  const all = [...fileTools, ...createMultiEditTools()];
  const tool = all.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} is exported`);
  return tool;
}

function edit(args: Record<string, unknown>): Promise<ToolResult> {
  return findTool("file_edit").run(args, ctx);
}

function multiEdit(args: Record<string, unknown>): Promise<ToolResult> {
  return findTool("file_multi_edit").run(args, ctx);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-edit-schema-"));
  file = path.join(tmpDir, "sample.txt");
  ctx = { cfg: { policy: { allowOutsideWorkspaceRead: false } } as never, workspace: tmpDir, emit: () => {} };
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("file_edit schema aliases", () => {
  it("accepts the canonical old_string/new_string spelling", async () => {
    fs.writeFileSync(file, "alpha\nbeta\n", "utf8");
    const res = await edit({ path: "sample.txt", old_string: "beta", new_string: "BETA" });
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), "alpha\nBETA\n");
    assert.match(res.content, /replaced 1 occurrence/);
  });

  it("keeps find/replace as working aliases", async () => {
    fs.writeFileSync(file, "alpha\nbeta\n", "utf8");
    const res = await edit({ path: "sample.txt", find: "alpha", replace: "ALPHA" });
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), "ALPHA\nbeta\n");
  });

  it("supports replace_all to replace every occurrence", async () => {
    fs.writeFileSync(file, "x\nx\nx\n", "utf8");
    const res = await edit({ path: "sample.txt", old_string: "x", new_string: "y", replace_all: true });
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), "y\ny\ny\n");
    assert.match(res.content, /replaced 3 occurrence/);
  });

  it("rejects a no-op edit when old_string equals new_string", async () => {
    fs.writeFileSync(file, "alpha\n", "utf8");
    const res = await edit({ path: "sample.txt", old_string: "alpha", new_string: "alpha" });
    assert.equal(res.ok, false);
    assert.match(res.content, /identical/i);
    assert.equal(fs.readFileSync(file, "utf8"), "alpha\n");
  });

  it("tells the model to add context when the match is not unique", async () => {
    fs.writeFileSync(file, "x\nx\n", "utf8");
    const res = await edit({ path: "sample.txt", old_string: "x", new_string: "y" });
    assert.equal(res.ok, false);
    assert.match(res.content, /not unique/i);
    assert.match(res.content, /2 matches/);
    assert.match(res.content, /add more surrounding context/i);
    assert.match(res.content, /replace_all/);
    assert.equal(fs.readFileSync(file, "utf8"), "x\nx\n");
  });

  it("reports a missing old_string and a missing required argument", async () => {
    fs.writeFileSync(file, "alpha\n", "utf8");
    const missing = await edit({ path: "sample.txt", old_string: "zzz", new_string: "y" });
    assert.equal(missing.ok, false);
    assert.match(missing.content, /not present/i);

    const noArgs = await edit({ path: "sample.txt" });
    assert.equal(noArgs.ok, false);
    assert.match(noArgs.content, /requires old_string/);
  });
});

describe("file_multi_edit schema aliases", () => {
  it("accepts the canonical old_string/new_string spelling", async () => {
    fs.writeFileSync(file, "alpha\nbeta\n", "utf8");
    const res = await multiEdit({
      path: "sample.txt",
      edits: [
        { old_string: "alpha", new_string: "ALPHA" },
        { old_string: "beta", new_string: "BETA" },
      ],
    });
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), "ALPHA\nBETA\n");
  });

  it("keeps find/replace as working aliases", async () => {
    fs.writeFileSync(file, "alpha\nbeta\n", "utf8");
    const res = await multiEdit({
      path: "sample.txt",
      edits: [
        { find: "alpha", replace: "ALPHA" },
        { find: "beta", replace: "BETA" },
      ],
    });
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), "ALPHA\nBETA\n");
  });

  it("supports replace_all per edit", async () => {
    fs.writeFileSync(file, "a a a\nb\n", "utf8");
    const res = await multiEdit({
      path: "sample.txt",
      edits: [
        { old_string: "a", new_string: "c", replace_all: true },
        { old_string: "b", new_string: "B" },
      ],
    });
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), "c c c\nB\n");
  });

  it("rejects a no-op edit without touching the file", async () => {
    fs.writeFileSync(file, "alpha\n", "utf8");
    const res = await multiEdit({ path: "sample.txt", edits: [{ old_string: "alpha", new_string: "alpha" }] });
    assert.equal(res.ok, false);
    assert.match(res.content, /identical/i);
    assert.equal(fs.readFileSync(file, "utf8"), "alpha\n");
  });

  it("tells the model to add context when an edit is not unique", async () => {
    fs.writeFileSync(file, "x\nx\n", "utf8");
    const res = await multiEdit({ path: "sample.txt", edits: [{ old_string: "x", new_string: "y" }] });
    assert.equal(res.ok, false);
    assert.match(res.content, /ambiguous/i);
    assert.match(res.content, /2 matches/);
    assert.match(res.content, /add more surrounding context/i);
    assert.match(res.content, /replace_all/);
    assert.equal(fs.readFileSync(file, "utf8"), "x\nx\n");
  });
});

describe("text_editor str_replace forwarding", () => {
  function textEditor(): Tool {
    const registry = new ToolRegistry();
    registry.registerAll(fileTools);
    const tools = createSpecAliasTools({ registry, ollama: {} as never });
    const tool = tools.find((t) => t.name === "text_editor");
    assert.ok(tool, "text_editor tool is exported");
    return tool;
  }

  it("forwards the canonical old_string/new_string spelling", async () => {
    fs.writeFileSync(file, "alpha\n", "utf8");
    const res = await textEditor().run(
      { action: "str_replace", path: "sample.txt", old_string: "alpha", new_string: "ALPHA" },
      ctx,
    );
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), "ALPHA\n");
  });

  it("keeps the spec oldStr/newStr spelling working", async () => {
    fs.writeFileSync(file, "alpha\n", "utf8");
    const res = await textEditor().run(
      { action: "str_replace", path: "sample.txt", oldStr: "alpha", newStr: "ALPHA" },
      ctx,
    );
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), "ALPHA\n");
  });
});
