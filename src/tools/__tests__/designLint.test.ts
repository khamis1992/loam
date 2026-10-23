/**
 * V4 tool tests: the design_lint agent tool.
 *
 * Covers the tool surface (validation, both input shapes, report content),
 * the filesystem walk (extension allow-list, skip reasons, recursion bounds)
 * and the prompt/registration wiring the design rules rely on.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { Config } from "../../config.js";
import { mergeAlwaysOnTools } from "../../server/runTools.js";
import {
  DESIGN_LINT_TOOL_NAME,
  createDesignLintTools,
} from "../designLint.js";
import { DESIGN_LINT_CATEGORIES, DESIGN_LINT_PROMPT } from "../../modes/designRules.js";

let workspace = "";
let ctx: { cfg: Config; workspace: string; emit: () => void };

const CLEAN = `<main className="min-h-screen bg-background text-foreground">\n  <button className="rounded-md bg-primary px-4 py-2">Go</button>\n</main>`;
const DIRTY = `<div className="bg-slate-500 text-[13px]">\n  <img src="/hero.png" />\n</div>`;

function parse(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-design-lint-"));
  ctx = {
    workspace,
    cfg: { policy: { allowOutsideWorkspaceRead: true, networkEnabled: false } } as unknown as Config,
    emit: () => {},
  };
  fs.writeFileSync(path.join(workspace, "Page.tsx"), DIRTY, "utf8");
  fs.writeFileSync(path.join(workspace, "Clean.tsx"), CLEAN, "utf8");
  fs.writeFileSync(path.join(workspace, "notes.txt"), DIRTY, "utf8");
  fs.mkdirSync(path.join(workspace, "components"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "components", "Card.tsx"), DIRTY, "utf8");
  fs.mkdirSync(path.join(workspace, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "node_modules", "dep", "index.tsx"), DIRTY, "utf8");
});

after(() => {
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("design_lint: tool surface", () => {
  it("exposes exactly one tool under the expected name", () => {
    const tools = createDesignLintTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, DESIGN_LINT_TOOL_NAME);
    assert.ok(tools[0]!.description.length > 200, "description must be complete, not trimmed for small models");
  });

  it("rejects an empty request", async () => {
    const tool = createDesignLintTools()[0]!;
    const result = await tool.run({}, ctx);
    assert.equal(result.ok, false);
    assert.match(result.content, /provide `source` or `paths`/);
  });

  it("rejects combining source and paths", async () => {
    const tool = createDesignLintTools()[0]!;
    const result = await tool.run({ source: CLEAN, paths: ["Page.tsx"] }, ctx);
    assert.equal(result.ok, false);
    assert.match(result.content, /not both/);
  });

  it("reports violations with line and column for an inline source", async () => {
    const tool = createDesignLintTools()[0]!;
    const result = await tool.run({ source: DIRTY, fileName: "inline.tsx" }, ctx);
    assert.equal(result.ok, false);
    assert.match(result.content, /inline\.tsx: \d+ violation\(s\)/);
    assert.match(result.content, /\[raw-colour\]/);
    assert.match(result.content, /\[arbitrary-px\]/);
    assert.match(result.content, /\[missing-alt\]/);
  });

  it("reports a clean pass for a token-only source", async () => {
    const tool = createDesignLintTools()[0]!;
    const result = await tool.run({ source: CLEAN }, ctx);
    assert.equal(result.ok, true);
    assert.match(result.content, /No design-system violations found/);
  });

  it("returns machine-readable JSON on request", async () => {
    const tool = createDesignLintTools()[0]!;
    const result = await tool.run({ source: DIRTY, fileName: "x.tsx", format: "json" }, ctx);
    assert.equal(result.ok, false);
    const payload = parse(result.content);
    assert.equal(payload["ok"], false);
    assert.equal(payload["file"], "x.tsx");
    assert.ok(Array.isArray(payload["violations"]));
  });

  it("honours maxColours, maxFonts, allowedColours and disabled", async () => {
    const tool = createDesignLintTools()[0]!;
    // Six distinct colours exceed the default five-colour palette.
    const palette = `<div><span style={{ color: "#111111" }}>a</span><span style={{ color: "#222222" }}>b</span><span style={{ color: "#333333" }}>c</span><span style={{ color: "#444444" }}>d</span><span style={{ color: "#555555" }}>e</span><span style={{ color: "#666666" }}>f</span></div>`;
    const hasPaletteViolation = (result: { content: string }): boolean => result.content.includes("[too-many-colours]");
    assert.equal(hasPaletteViolation(await tool.run({ source: palette }, ctx)), true);
    assert.equal(hasPaletteViolation(await tool.run({ source: palette, maxColours: 10 }, ctx)), false);

    const fonts = `<div className="font-sans font-heading font-mono">x</div>`;
    assert.equal((await tool.run({ source: fonts }, ctx)).ok, false);
    assert.equal((await tool.run({ source: fonts, maxFonts: 3 }, ctx)).ok, true);

    const white = `<div className="bg-white">w</div>`;
    assert.equal((await tool.run({ source: white }, ctx)).ok, false);
    assert.equal((await tool.run({ source: white, allowedColours: ["bg-white"] }, ctx)).ok, true);

    const img = `<img src="/x.png" />`;
    assert.equal((await tool.run({ source: img, disabled: ["missing-alt"] }, ctx)).ok, true);
  });
});

describe("design_lint: filesystem walk", () => {
  it("lists the files it linted for an explicit file", async () => {
    const tool = createDesignLintTools()[0]!;
    const result = await tool.run({ paths: ["Page.tsx"], format: "json" }, ctx);
    assert.equal(result.ok, false);
    const payload = parse(result.content);
    assert.deepEqual(payload["files"], ["Page.tsx"]);
    assert.equal(payload["totalViolations"], 3);
  });

  it("walks a directory recursively and skips non-UI directories", async () => {
    const tool = createDesignLintTools()[0]!;
    const result = await tool.run({ paths: ["."], format: "json" }, ctx);
    assert.equal(result.ok, false);
    const payload = parse(result.content);
    const files = payload["files"] as string[];
    assert.ok(files.includes("Page.tsx"));
    assert.ok(files.includes("components/Card.tsx"));
    assert.ok(!files.includes("notes.txt"), "non-lintable extension must be skipped");
    assert.ok(!files.some((f) => f.includes("node_modules")), "node_modules must never be walked");
    assert.equal(payload["totalViolations"], 6);
  });

  it("explains skipped paths instead of failing silently", async () => {
    const tool = createDesignLintTools()[0]!;
    const result = await tool.run({ paths: ["missing.tsx", "notes.txt"] }, ctx);
    assert.equal(result.ok, true);
    assert.match(result.content, /skipped missing\.tsx: not found/);
    assert.match(result.content, /skipped notes\.txt: unsupported extension/);
  });

  it("returns a truthful verdict for a directory with nothing to check", async () => {
    const empty = fs.mkdtempSync(path.join(workspace, "empty"));
    try {
      const tool = createDesignLintTools()[0]!;
      const result = await tool.run({ paths: ["empty"] }, ctx);
      assert.equal(result.ok, true);
      assert.match(result.content, /nothing to check/);
      assert.match(result.content, /0 lintable files among 1 path\(s\)/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("never writes to the workspace while linting", async () => {
    const before2 = fs.readdirSync(workspace).sort().join(",");
    const tool = createDesignLintTools()[0]!;
    await tool.run({ paths: ["."] }, ctx);
    assert.equal(fs.readdirSync(workspace).sort().join(","), before2);
  });
});

describe("design_lint: prompt and registration wiring", () => {
  it("appears in the effective allowlist after merging always-on tools", () => {
    const merged = mergeAlwaysOnTools({ resolvedAllow: [], registeredTools: [DESIGN_LINT_TOOL_NAME] });
    assert.ok(merged.includes(DESIGN_LINT_TOOL_NAME));
  });

  it("injects the design-rules directive into the system prompt only when available", async () => {
    const { buildSystemPrompt } = await import("../../agent/prompt.js");
    const cfg = { workspace, policy: { networkEnabled: false } } as unknown as Config;
    const withTool = buildSystemPrompt(cfg, [], [DESIGN_LINT_TOOL_NAME]);
    assert.match(withTool, /at most five distinct colours/);
    assert.match(withTool, /dir="rtl"/);
    const withoutTool = buildSystemPrompt(cfg, [], ["file_read"]);
    assert.ok(!withoutTool.includes("at most five distinct colours"));
  });

  it("documents the categories the linter can emit", () => {
    assert.ok(DESIGN_LINT_CATEGORIES.includes("raw-colour"));
    assert.ok(DESIGN_LINT_CATEGORIES.includes("rtl-direction"));
    assert.match(DESIGN_LINT_PROMPT, /design_lint/);
    assert.match(DESIGN_LINT_PROMPT, /disabled/);
  });

  it("requires design_lint in the build phases that produce UI", async () => {
    const { BUILD_SUBPHASES } = await import("../../modes/buildPhases.js");
    const explore = BUILD_SUBPHASES.phases.find((p) => p.id === "design-explore")!;
    assert.ok(explore.tools.includes(DESIGN_LINT_TOOL_NAME));
    const implement = BUILD_SUBPHASES.phases.find((p) => p.id === "implement")!;
    assert.ok(implement.tools.includes(DESIGN_LINT_TOOL_NAME));
  });
});
