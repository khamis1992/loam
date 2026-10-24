import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

let dir: string;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-interop-"));
  process.env.MANUS_LOCAL_DATA_DIR = dir;
});
after(async () => {
  (await import("../handoff.js")).closeHandoffs();
  (await import("../wikiIndex.js")).closeIndex();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("wiki interop", () => {
  it("exports CURRENT.md with open handoffs", async () => {
    const { createHandoff } = await import("../handoff.js");
    const { exportCurrent } = await import("../interop.js");
    const root = path.join(dir, "wiki-a");
    const ws = path.join(dir, "ws");
    createHandoff(root, { title: "Finish parser", body: "todo" });
    const file = exportCurrent(root, ws);
    assert.equal(file, path.join(ws, ".loam", "handoff", "CURRENT.md"));
    assert.match(fs.readFileSync(file, "utf8"), /Finish parser/);
  });
  it("imports Claude memory and Codex AGENTS.md as notes", async () => {
    const { importClaude, importCodex } = await import("../interop.js");
    const { readPage } = await import("../store.js");
    const root = path.join(dir, "wiki-b");
    const mem = path.join(dir, "mem");
    fs.mkdirSync(mem);
    fs.writeFileSync(path.join(mem, "MEMORY.md"), "- index\n");
    fs.writeFileSync(path.join(mem, "build.md"), "---\nname: build\n---\n# Build\nrun npm test\n");
    assert.equal(importClaude(root, mem), 1);
    assert.match(readPage(root, "note", "claude-build")!.body, /npm test/);
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Rules\nuse tabs\n");
    assert.equal(importCodex(root, dir), 1);
    assert.equal(importCodex(root, path.join(dir, "missing")), 0);
  });
});
