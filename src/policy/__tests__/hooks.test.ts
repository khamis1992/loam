/**
 * Tests for the workspace hook policy (hooks.ts).
 *
 * Guarantees under test:
 *  - rules are loaded from the global and workspace hooks.json files
 *  - the workspace copy is written back with every event group
 *  - a PreCompact hook receives the compaction context and can veto it
 *  - a non-zero exit from a PreToolUse hook blocks that tool call
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { loadHooksConfig, saveWorkspaceHooks, runPreCompactHooks, runLifecycleHooks, type HooksConfig } from "../hooks.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-hooks-"));
  process.chdir(tmpDir);
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** Write a hooks.json with a cross-platform `node -e` command. */
function writeHooks(workspace: string, groups: Record<string, unknown>): void {
  const dir = path.join(workspace, ".manus");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify(groups), "utf8");
}

/** A command that exits `code` and prints `text`. */
function shellExit(code: number, text = ""): string {
  return `node -e "process.stdout.write(${JSON.stringify(text)});process.exit(${code})"`;
}

describe("hooks config", () => {
  it("loads PreCompact rules from the workspace hooks file", () => {
    writeHooks(tmpDir, { PreCompact: [{ command: shellExit(0) }] });
    const cfg = loadHooksConfig(tmpDir);
    assert.equal(cfg.PreCompact?.length, 1);
    assert.equal(cfg.PreToolUse?.length, 0);
  });

  it("ignores malformed hooks files without throwing", () => {
    fs.mkdirSync(path.join(tmpDir, ".manus"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".manus", "hooks.json"), "{not json", "utf8");
    assert.deepEqual(loadHooksConfig(tmpDir), { PreToolUse: [], PostToolUse: [], PreCompact: [] });
  });

  it("persists every event group and drops entries without a command", () => {
    const config = {
      PreToolUse: [{ matcher: "file_write", command: "echo pre" }],
      PreCompact: [{ matcher: "", command: "echo compact" }, { matcher: "ignored" }],
    } as unknown as HooksConfig;
    const file = saveWorkspaceHooks(tmpDir, config);
    assert.equal(fs.existsSync(file), true);
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.deepEqual(saved.PreToolUse, [{ matcher: "file_write", command: "echo pre" }]);
    assert.deepEqual(saved.PreCompact, [{ matcher: "", command: "echo compact" }]);
    assert.equal(Array.isArray(saved.PostToolUse), true);
  });
});

describe("PreCompact hooks", () => {
  it("does nothing when no rule is configured", async () => {
    const result = await runPreCompactHooks({ model: "m", window: 1000, threshold: 500, tokens: 900, messages: 4 }, tmpDir);
    assert.equal(result.blocked, false);
    assert.equal(result.outcomes.length, 0);
  });

  it("passes the compaction context to the hook and lets it observe without vetoing", async () => {
    const seen = path.join(tmpDir, "seen.json");
    // A helper script avoids nested-quote breakage when the command is run through cmd.exe.
    const helper = path.join(tmpDir, "dump-stdin.mjs");
    fs.writeFileSync(helper, `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify(JSON.parse(fs.readFileSync(0, "utf8"))));\n`, "utf8");
    writeHooks(tmpDir, { PreCompact: [{ command: `node ${JSON.stringify(helper)}` }] });

    const result = await runPreCompactHooks({ model: "qwen2.5:14b", window: 32768, threshold: 12768, tokens: 15000, messages: 42 }, tmpDir);

    assert.equal(result.blocked, false);
    assert.equal(result.outcomes.length, 1);
    assert.equal(result.outcomes[0]!.code, 0);
    const received = JSON.parse(fs.readFileSync(seen, "utf8")) as Record<string, unknown>;
    assert.deepEqual(received, { model: "qwen2.5:14b", window: 32768, threshold: 12768, tokens: 15000, messages: 42 });
  });

  it("vetoes the compaction when a rule exits non-zero", async () => {
    writeHooks(tmpDir, { PreCompact: [{ command: shellExit(3, "cannot compact now") }] });
    const result = await runPreCompactHooks({ model: "m", window: 1000, threshold: 500, tokens: 900, messages: 4 }, tmpDir);
    assert.equal(result.blocked, true);
    assert.match(result.message, /blocked compaction/);
    assert.match(result.message, /cannot compact now/);
  });

  it("honours blockOnFail: false so a failing rule only reports", async () => {
    writeHooks(tmpDir, { PreCompact: [{ command: shellExit(1), blockOnFail: false }] });
    const result = await runPreCompactHooks({ model: "m", window: 1000, threshold: 500, tokens: 900, messages: 4 }, tmpDir);
    assert.equal(result.blocked, false);
    assert.match(result.message, /PreCompact hook/);
  });
});

describe("lifecycle hooks", () => {
  it("blocks a matching PreToolUse rule that exits non-zero", async () => {
    writeHooks(tmpDir, { PreToolUse: [{ matcher: "file_write", command: shellExit(1, "denied") }] });
    const result = await runLifecycleHooks("PreToolUse", "file_write", { path: "a.ts" }, tmpDir);
    assert.equal(result.blocked, true);
    assert.match(result.message, /denied/);
  });

  it("does not run a rule whose matcher does not match", async () => {
    writeHooks(tmpDir, { PreToolUse: [{ matcher: "file_write", command: shellExit(1) }] });
    const result = await runLifecycleHooks("PreToolUse", "file_read", { path: "a.ts" }, tmpDir);
    assert.equal(result.blocked, false);
    assert.equal(result.outcomes.length, 0);
  });

  it("ignores PreCompact rules when running a tool lifecycle event", async () => {
    writeHooks(tmpDir, { PreCompact: [{ command: shellExit(1) }] });
    const result = await runLifecycleHooks("PreToolUse", "file_read", {}, tmpDir);
    assert.equal(result.blocked, false);
    assert.equal(result.outcomes.length, 0);
  });
});
