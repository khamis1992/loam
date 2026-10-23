/**
 * Unit tests for the expanded hook surface.
 *
 * Each lifecycle event must run its configured command in the workspace with
 * the event exposed through the environment, and the expanded events must
 * honour JSON stdout decisions (`block`, `additionalContext`) plus the
 * conventional exit-code-2 blocking signal. The two original tool events keep
 * their existing contract.
 */
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadHooksConfig,
  saveWorkspaceHooks,
  runLifecycleHooks,
  type HookEvent,
  type HookRule,
  type HooksConfig,
} from "../hooks.js";

const FIXTURE = `const arg = process.argv[2] || "";
const out = {
  event: process.env.MANUS_HOOK_EVENT || "",
  tool: process.env.MANUS_TOOL_NAME || "",
  file: process.env.MANUS_FILE_PATH || "",
  prompt: process.env.MANUS_PROMPT || "",
  subagent: process.env.MANUS_SUBAGENT || "",
  stopReason: process.env.MANUS_STOP_REASON || "",
};
if (arg === "block") out.decision = "block";
else if (arg === "block-reason") { out.decision = "block"; out.reason = "not allowed"; }
else if (arg === "context") out.additionalContext = "injected context";
else if (arg === "prose-block") { console.log("a warning line"); console.log(JSON.stringify({ decision: "block", reason: "prose" })); process.exit(0); }
else if (arg === "exit1") { console.log("soft failure"); process.exit(1); }
else if (arg === "exit2") { console.log("hard failure"); process.exit(2); }
console.log(JSON.stringify(out));
`;

const DECISION_EVENTS: HookEvent[] = [
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "SubagentStart",
  "SubagentStop",
];

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loam-hooks-"));
}

function writeFixture(workspace: string): string {
  const file = path.join(workspace, "hook_fixture.js");
  fs.writeFileSync(file, FIXTURE, "utf8");
  return file;
}

function writeHooks(workspace: string, config: HooksConfig): void {
  const dir = path.join(workspace, ".manus");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify(config), "utf8");
}

function configWith(event: HookEvent, ...rules: HookRule[]): HooksConfig {
  return { [event]: rules } as HooksConfig;
}

function command(fixture: string, arg = ""): string {
  return `node "${fixture}"${arg ? ` ${arg}` : ""}`;
}

function parseOutput(outcome: { output: string }): Record<string, unknown> {
  return JSON.parse(outcome.output) as Record<string, unknown>;
}

test("loadHooksConfig/saveWorkspaceHooks round-trip every event", () => {
  const workspace = makeWorkspace();
  const cfg: HooksConfig = {
    PreToolUse: [{ matcher: "Bash", command: "echo pre" }],
    PostToolUse: [{ matcher: "", command: "echo post" }],
    UserPromptSubmit: [{ matcher: "", command: "echo ups" }],
    Stop: [{ matcher: "", command: "echo stop" }],
    SessionStart: [{ matcher: "", command: "echo ss" }],
    SessionEnd: [{ matcher: "", command: "echo se" }],
    PreCompact: [{ matcher: "", command: "echo pc" }],
    SubagentStart: [{ matcher: "", command: "echo subs" }],
    SubagentStop: [{ matcher: "", command: "echo sube" }],
  };
  saveWorkspaceHooks(workspace, cfg);
  assert.deepEqual(loadHooksConfig(workspace), cfg);
});

for (const event of DECISION_EVENTS) {
  test(`runLifecycleHooks fires ${event} with the event exposed`, async () => {
    const workspace = makeWorkspace();
    const fixture = writeFixture(workspace);
    writeHooks(workspace, configWith(event, { matcher: "", command: command(fixture) }));

    const res = await runLifecycleHooks(event, "", {}, workspace);
    assert.equal(res.blocked, false);
    assert.equal(res.outcomes.length, 1);
    assert.equal(parseOutput(res.outcomes[0]!).event, event);
  });
}

test("UserPromptSubmit returns additionalContext and forwards the prompt", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFixture(workspace);
  writeHooks(workspace, configWith("UserPromptSubmit", { matcher: "", command: command(fixture, "context") }));

  const res = await runLifecycleHooks("UserPromptSubmit", "", { prompt: "the user prompt" }, workspace);
  assert.equal(res.blocked, false);
  assert.equal(res.additionalContext, "injected context");
  assert.equal(parseOutput(res.outcomes[0]!).prompt, "the user prompt");
});

test("Stop JSON decision block sets blocked with the reason", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFixture(workspace);
  writeHooks(workspace, configWith("Stop", { matcher: "", command: command(fixture, "block-reason") }));

  const res = await runLifecycleHooks("Stop", "", { stopReason: "completed" }, workspace);
  assert.equal(res.blocked, true);
  assert.match(res.message, /not allowed/);
  assert.equal(parseOutput(res.outcomes[0]!).stopReason, "completed");
});

test("a JSON block decision is detected after leading prose", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFixture(workspace);
  writeHooks(workspace, configWith("Stop", { matcher: "", command: command(fixture, "prose-block") }));

  const res = await runLifecycleHooks("Stop", "", {}, workspace);
  assert.equal(res.blocked, true);
  assert.match(res.message, /prose/);
});

test("PreCompact JSON decision block sets blocked", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFixture(workspace);
  writeHooks(workspace, configWith("PreCompact", { matcher: "", command: command(fixture, "block") }));

  const res = await runLifecycleHooks("PreCompact", "", { trigger: "auto" }, workspace);
  assert.equal(res.blocked, true);
  assert.equal(res.outcomes[0]!.decision?.decision, "block");
});

test("SubagentStart exposes the subagent name and additionalContext", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFixture(workspace);
  writeHooks(workspace, configWith("SubagentStart", { matcher: "", command: command(fixture, "context") }));

  const res = await runLifecycleHooks("SubagentStart", "", { subagent: "explore", task: "find files" }, workspace);
  assert.equal(res.blocked, false);
  assert.equal(res.additionalContext, "injected context");
  assert.equal(parseOutput(res.outcomes[0]!).subagent, "explore");
});

test("expanded events treat exit code 2 as blocking", async () => {
  for (const event of DECISION_EVENTS) {
    const workspace = makeWorkspace();
    const fixture = writeFixture(workspace);
    writeHooks(workspace, configWith(event, { matcher: "", command: command(fixture, "exit2") }));
    const res = await runLifecycleHooks(event, "", {}, workspace);
    assert.equal(res.blocked, true, event);
  }
});

test("PreToolUse still blocks on a non-zero exit by default", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFixture(workspace);
  writeHooks(workspace, configWith("PreToolUse", { matcher: "", command: command(fixture, "exit1") }));

  const res = await runLifecycleHooks("PreToolUse", "file_write", { path: "a.ts" }, workspace);
  assert.equal(res.blocked, true);
  assert.match(res.message, /PreToolUse hook blocked/);
  assert.equal(res.outcomes[0]!.code, 1);
});

test("PreToolUse blockOnFail false ignores a non-zero exit", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFixture(workspace);
  writeHooks(workspace, configWith("PreToolUse", { matcher: "", command: command(fixture, "exit1"), blockOnFail: false }));

  const res = await runLifecycleHooks("PreToolUse", "file_write", {}, workspace);
  assert.equal(res.blocked, false);
});

test("PostToolUse never blocks on its own exit code", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFixture(workspace);
  writeHooks(workspace, configWith("PostToolUse", { matcher: "", command: command(fixture, "exit2") }));

  const res = await runLifecycleHooks("PostToolUse", "file_write", {}, workspace);
  assert.equal(res.blocked, false);
});

test("a matcher does not disable a lifecycle event hook", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFixture(workspace);
  writeHooks(workspace, configWith("Stop", { matcher: "never-used", command: command(fixture, "context") }));

  const res = await runLifecycleHooks("Stop", "", {}, workspace);
  assert.equal(res.outcomes.length, 1);
  assert.equal(res.additionalContext, "injected context");
});

test("PreToolUse matcher restricts which tool names trigger", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFixture(workspace);
  writeHooks(workspace, configWith("PreToolUse", { matcher: "Bash", command: command(fixture, "exit2") }));

  const res = await runLifecycleHooks("PreToolUse", "file_read", {}, workspace);
  assert.equal(res.outcomes.length, 0);
  assert.equal(res.blocked, false);
});
