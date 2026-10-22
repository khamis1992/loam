/**
 * C7 unit tests: project memory (LOAM.md / AGENTS.md / CLAUDE.md).
 *
 * The loader must be fail-safe (a missing, unreadable or oversized file never
 * breaks prompt assembly), hierarchical (root + subdirectory on demand),
 * import-aware (`@path` / `#[[file:path]]` with a bounded depth and a cycle
 * guard), and budgeted. `memory_add` is the write side: one atomic note under a
 * section heading, never escaping the workspace.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  PROJECT_MEMORY_FILES,
  appendMemoryEntry,
  loadMemoryForFile,
  loadProjectMemory,
  type ProjectMemoryOptions,
} from "../projectMemory.js";
import { projectMemoryTools, MEMORY_ADD_TOOL_NAME } from "../../tools/projectMemoryTools.js";
import { ToolRegistry } from "../../tools/registry.js";
import { buildSystemPrompt } from "../prompt.js";
import type { Config } from "../../config.js";

let root = "";
let home = "";
let workspace = "";

function write(file: string, content: string): string {
  const full = path.join(workspace, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

function opts(overrides: ProjectMemoryOptions = {}): ProjectMemoryOptions {
  return { homeDir: home, ...overrides };
}

const cfg = { workspace: "/tmp/does-not-exist", policy: { networkEnabled: false } } as unknown as Config;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-project-memory-"));
  home = path.join(root, "home");
  workspace = path.join(root, "ws");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
});

after(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("project memory loader", () => {
  it("loads the user-level and project-level files in priority order", () => {
    fs.writeFileSync(path.join(home, "LOAM.md"), "# Home rules\nhome-level note", "utf8");
    fs.writeFileSync(path.join(workspace, "LOAM.md"), "# Project rules\nproject-level note", "utf8");

    const result = loadProjectMemory(workspace, opts());
    assert.ok(result.text.includes("project-level note"), "project root memory is included");
    assert.ok(result.text.includes("home-level note"), "user-level memory is included");
    // Project-level is rendered after user-level, so it appears later in the block.
    assert.ok(result.text.indexOf("project-level note") > result.text.indexOf("home-level note"));
    assert.ok(result.files.some((f) => f === path.join(workspace, "LOAM.md")));
    assert.ok(result.files.some((f) => f === path.join(home, "LOAM.md")));
    assert.equal(result.truncated, false);
  });

  it("accepts AGENTS.md and CLAUDE.md as compatibility names", () => {
    for (const name of PROJECT_MEMORY_FILES) {
      const dir = path.join(root, `compat-${name}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), `compat note for ${name}`, "utf8");
      const result = loadProjectMemory(dir, opts());
      assert.ok(result.text.includes(`compat note for ${name}`), `${name} is loaded`);
    }
  });

  it("loads subdirectory memory on demand when a file there is read", () => {
    write("sub/AGENTS.md", "# Sub rules\nsubdirectory note");
    write("sub/deep/CLAUDE.md", "# Deep rules\ndeeper note");
    const target = write("sub/deep/source.ts", "export const x = 1;\n");

    const result = loadMemoryForFile(target, workspace, opts());
    assert.ok(result.text.includes("subdirectory note"), "nearest subdirectory memory is included");
    assert.ok(result.text.includes("deeper note"), "deeper subdirectory memory is included");
    // The workspace root is already in the system prompt, so it is excluded by default.
    assert.ok(!result.text.includes("project-level note"), "root memory is excluded on demand");
  });

  it("includes the workspace root only when explicitly requested", () => {
    write("sub/AGENTS.md", "# Sub rules\nsubdirectory note");
    const target = write("sub/source.ts", "export const y = 2;\n");
    const result = loadMemoryForFile(target, workspace, opts(), true);
    assert.ok(result.text.includes("subdirectory note"));
    assert.ok(result.text.includes("project-level note"), "root memory is included when requested");
  });

  it("ignores files outside the workspace instead of walking above it", () => {
    const outside = path.join(root, "outside.md");
    fs.writeFileSync(outside, "outside note", "utf8");
    const result = loadMemoryForFile(outside, workspace, opts());
    assert.equal(result.text, "");
    assert.equal(result.files.length, 0);
  });

  it("resolves @path and #[[file:path]] imports", () => {
    write("LOAM.md", "# Rules\n@./docs/conventions.md");
    write("docs/conventions.md", "# Conventions\nimported convention body");
    const result = loadProjectMemory(workspace, opts());
    assert.ok(result.text.includes("imported convention body"), "@path import is resolved");
  });

  it("guards against import cycles instead of looping", () => {
    write("LOAM.md", "# Rules\n@./a.md");
    write("a.md", "# A\n@./b.md");
    write("b.md", "# B\n@./a.md");
    const result = loadProjectMemory(workspace, opts());
    assert.ok(result.text.includes("# A"));
    assert.ok(result.text.includes("# B"));
    assert.ok(result.cycles >= 1, "the cycle is counted");
    // Each file is rendered at most once.
    assert.equal(result.text.split("# A").length - 1, 1);
    assert.equal(result.text.split("# B").length - 1, 1);
  });

  it("stops at the configured import depth", () => {
    write("LOAM.md", "# Rules\n@./l1.md");
    write("l1.md", "@./l2.md");
    write("l2.md", "@./l3.md");
    write("l3.md", "too deep to load");
    const result = loadProjectMemory(workspace, opts({ maxImportDepth: 1 }));
    assert.ok(!result.text.includes("too deep to load"), "content past the depth limit is not loaded");
    assert.equal(result.truncated, true);
  });

  it("caps the total rendered size", () => {
    write("LOAM.md", "x".repeat(20_000));
    const result = loadProjectMemory(workspace, opts({ maxBytes: 5_000 }));
    assert.equal(result.truncated, true);
    assert.ok(result.text.length <= 5_000 + 200, "rendered block respects the budget");
  });

  it("caps a single oversized file", () => {
    write("LOAM.md", "y".repeat(50_000));
    const result = loadProjectMemory(workspace, opts({ maxBytes: 100_000, maxFileBytes: 1_000 }));
    assert.equal(result.truncated, true);
    assert.ok(result.text.length < 50_000, "the file is truncated to the per-file budget");
  });

  it("is fail-safe when nothing is present", () => {
    const empty = path.join(root, "empty-ws");
    const emptyHome = path.join(root, "empty-home");
    fs.mkdirSync(empty, { recursive: true });
    fs.mkdirSync(emptyHome, { recursive: true });
    const result = loadProjectMemory(empty, opts({ homeDir: emptyHome }));
    assert.equal(result.text, "");
    assert.equal(result.files.length, 0);
    assert.equal(result.truncated, false);
  });
});

describe("project memory in the system prompt", () => {
  it("injects root project memory into the built prompt", () => {
    fs.writeFileSync(path.join(workspace, "LOAM.md"), "# Rules\nprompt-level note", "utf8");
    const memory = loadProjectMemory(workspace, opts());
    const prompt = buildSystemPrompt(cfg, [], ["file_read"], [], undefined, undefined, memory);
    assert.ok(prompt.includes("prompt-level note"), "root memory reaches the system prompt");
  });

  it("can be skipped explicitly", () => {
    const prompt = buildSystemPrompt(cfg, [], ["file_read"], [], undefined, undefined, null);
    assert.ok(!prompt.includes("prompt-level note"));
  });
});

describe("memory_add quick-add", () => {
  it("creates the file and files the note under a section", () => {
    const target = path.join(workspace, "LOAM.md");
    fs.rmSync(target, { force: true });
    const first = appendMemoryEntry("Run `npm run build:server` before e2e tests", workspace);
    assert.equal(first.file, target);
    const created = fs.readFileSync(target, "utf8");
    assert.match(created, /## Memory/);
    assert.ok(created.startsWith("## Memory"), "a new file starts at its heading, not a blank line");
    assert.match(fs.readFileSync(target, "utf8"), /- Run `npm run build:server` before e2e tests/);

    appendMemoryEntry("Use pnpm, not npm", workspace);
    const body = fs.readFileSync(target, "utf8");
    assert.equal(body.split("## Memory").length - 1, 1, "the section is reused, not duplicated");
    assert.ok(body.includes("- Use pnpm, not npm"));
  });

  it("keeps existing content and appends a new section", () => {
    const target = path.join(workspace, "LOAM.md");
    fs.writeFileSync(target, "# Rules\nkeep me", "utf8");
    appendMemoryEntry("decision note", workspace, "LOAM.md", "Decisions");
    const body = fs.readFileSync(target, "utf8");
    assert.ok(body.includes("keep me"));
    assert.ok(body.includes("## Decisions"));
    assert.ok(body.includes("- decision note"));
  });

  it("rejects a target that escapes the workspace", () => {
    assert.throws(
      () => appendMemoryEntry("escape", workspace, path.join(root, "outside.md")),
      /escapes the workspace/,
    );
  });

  it("is registered as a tool and writes through the registry", async () => {
    const registry = new ToolRegistry();
    registry.registerAll(projectMemoryTools);
    const tool = registry.get(MEMORY_ADD_TOOL_NAME);
    assert.ok(tool, "memory_add is registered");
    assert.ok(tool!.description.length >= 200, "the description is full and prescriptive");

    const target = path.join(workspace, "LOAM.md");
    fs.rmSync(target, { force: true });
    const result = await registry.exec(
      MEMORY_ADD_TOOL_NAME,
      { text: "registry note", section: "Build" },
      { cfg, workspace, emit: () => {} },
    );
    assert.equal(result.ok, true);
    assert.match(fs.readFileSync(target, "utf8"), /- registry note/);
  });

  it("rejects an empty note", async () => {
    const registry = new ToolRegistry();
    registry.registerAll(projectMemoryTools);
    const result = await registry.exec(
      MEMORY_ADD_TOOL_NAME,
      { text: "   " },
      { cfg, workspace, emit: () => {} },
    );
    assert.equal(result.ok, false);
    assert.match(result.content, /non-empty/);
  });
});
