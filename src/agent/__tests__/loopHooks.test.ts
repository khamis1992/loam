/**
 * Integration tests for the expanded hook events wired into the agent loop.
 *
 * These use a fake model (no network) and throwaway workspaces that carry a
 * `.manus/hooks.json` file, so the loop itself runs the hooks.
 */
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../config.js";
import { runAgent } from "../loop.js";
import type { AgentEvent } from "../events.js";
import type { ChatMessage, ChatOptions, ChatResult, OllamaClient } from "../../ollama.js";
import { ToolRegistry } from "../../tools/registry.js";

const VERIFIER_MARKER = "COMPLETED task as a whole";

const STOP_FIXTURE = `const fs = require('fs');
const path = require('path');
const ws = process.env.MANUS_WORKSPACE || process.cwd();
const counter = path.join(ws, '.stop-blocked');
if (!fs.existsSync(counter)) {
  fs.writeFileSync(counter, '1');
  console.log(JSON.stringify({ decision: 'block', reason: 'continue once' }));
} else {
  console.log('{}');
}
`;

const SESSION_FIXTURE = `const fs = require('fs');
const path = require('path');
const ws = process.env.MANUS_WORKSPACE || process.cwd();
fs.appendFileSync(path.join(ws, '.hook-log'), (process.env.MANUS_HOOK_EVENT || '?') + '\\n');
if (process.env.MANUS_HOOK_EVENT === 'SessionStart') console.log(JSON.stringify({ additionalContext: 'SESSION-START-CTX' }));
`;

const BLOCK_FIXTURE = `console.log(JSON.stringify({ decision: 'block', reason: 'not now' }));\n`;

const PRECOMPACT_FIXTURE = `const fs = require('fs');
const path = require('path');
fs.appendFileSync(path.join(process.env.MANUS_WORKSPACE || process.cwd(), '.hook-log'), 'PreCompact\\n');
console.log(JSON.stringify({ decision: 'block' }));
`;

const SESSION_END_REASON_FIXTURE = `const fs = require('fs');
const path = require('path');
fs.writeFileSync(
  path.join(process.env.MANUS_WORKSPACE || process.cwd(), '.session-end-reason'),
  process.env.MANUS_ARG_reason || 'unknown',
);
`;

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loam-loop-hooks-"));
}

function writeFile(workspace: string, name: string, contents: string): string {
  const file = path.join(workspace, name);
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

function writeHooks(workspace: string, config: Record<string, unknown>): void {
  const dir = path.join(workspace, ".manus");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify(config), "utf8");
}

function command(file: string): string {
  return `node "${file}"`;
}

interface Client {
  client: OllamaClient;
  executorCalls: () => number;
}

function makeClient(onExecutor: (call: number, messages: ChatMessage[]) => ChatResult): Client {
  let calls = 0;
  const client = {
    chat: async (options: ChatOptions): Promise<ChatResult> => {
      const system = String(options.messages[0]?.content ?? "");
      if (system.includes(VERIFIER_MARKER)) {
        return {
          model: "fixture",
          content: JSON.stringify({ verdict: "pass", reason: "verified", fixes: [] }),
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        };
      }
      calls += 1;
      return onExecutor(calls, options.messages);
    },
  } as unknown as OllamaClient;
  return { client, executorCalls: () => calls };
}

function answer(content: string): ChatResult {
  return { model: "fixture", content, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
}

function makeConfig(workspace: string): ReturnType<typeof loadConfig> {
  const cfg = loadConfig();
  cfg.workspace = workspace;
  cfg.model = "qwen2.5:14b";
  cfg.fallbackModel = cfg.model;
  cfg.compression.enabled = false;
  cfg.agent.maxSteps = 6;
  return cfg;
}

test("a Stop hook returning decision block forces another loop step", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFile(workspace, "stop_fixture.js", STOP_FIXTURE);
  writeHooks(workspace, { Stop: [{ matcher: "", command: command(fixture), timeoutMs: 10000 }] });

  const { client, executorCalls } = makeClient(() => answer("all done"));
  const result = await runAgent({ cfg: makeConfig(workspace), ollama: client, tools: new ToolRegistry(), prompt: "do the thing", emit: () => {} });

  assert.equal(result.verified, true);
  assert.equal(result.steps, 2, "the blocked Stop must cause another step");
  assert.equal(executorCalls(), 2);
  assert.ok(fs.existsSync(path.join(workspace, ".stop-blocked")), "the Stop hook ran");
});

test("SessionStart additionalContext is injected and SessionEnd fires", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFile(workspace, "session_fixture.js", SESSION_FIXTURE);
  writeHooks(workspace, {
    SessionStart: [{ matcher: "", command: command(fixture), timeoutMs: 10000 }],
    SessionEnd: [{ matcher: "", command: command(fixture), timeoutMs: 10000 }],
  });

  const captured: string[] = [];
  const { client } = makeClient((_call, messages) => {
    captured.push(messages.map((m) => m.content).join("\n"));
    return answer("done");
  });

  const result = await runAgent({ cfg: makeConfig(workspace), ollama: client, tools: new ToolRegistry(), prompt: "hi", emit: () => {} });
  assert.equal(result.verified, true);
  assert.ok(captured[0]!.includes("SESSION-START-CTX"), "SessionStart context reached the model");

  const events = fs.readFileSync(path.join(workspace, ".hook-log"), "utf8").trim().split(/\r?\n/);
  assert.ok(events.includes("SessionStart"), "SessionStart fired");
  assert.ok(events.includes("SessionEnd"), "SessionEnd fired");
});

test("UserPromptSubmit block prevents the run from starting", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFile(workspace, "ups_fixture.js", BLOCK_FIXTURE);
  writeHooks(workspace, { UserPromptSubmit: [{ matcher: "", command: command(fixture), timeoutMs: 10000 }] });

  const { client, executorCalls } = makeClient(() => answer("should not run"));
  await assert.rejects(
    runAgent({ cfg: makeConfig(workspace), ollama: client, tools: new ToolRegistry(), prompt: "hi", emit: () => {} }),
    /UserPromptSubmit/,
  );
  assert.equal(executorCalls(), 0, "the model must not be called after a blocked prompt");
});

test("PreCompact block prevents context compression", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFile(workspace, "pc_fixture.js", PRECOMPACT_FIXTURE);
  writeHooks(workspace, { PreCompact: [{ matcher: "", command: command(fixture), timeoutMs: 10000 }] });

  const cfg = makeConfig(workspace);
  cfg.compression.enabled = true;
  cfg.compression.thresholdPercent = 0.01;

  const events: AgentEvent[] = [];
  const { client } = makeClient(() => answer("done"));
  const result = await runAgent({ cfg, ollama: client, tools: new ToolRegistry(), prompt: "hi", emit: (event) => events.push(event) });

  assert.equal(result.verified, true);
  assert.equal(events.some((e) => e.type === "compaction"), false, "a blocked PreCompact must skip compression");
  assert.ok(fs.existsSync(path.join(workspace, ".hook-log")), "the PreCompact hook ran");
});

test("SessionStart block prevents the run from starting", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFile(workspace, "ss_fixture.js", BLOCK_FIXTURE);
  writeHooks(workspace, { SessionStart: [{ matcher: "", command: command(fixture), timeoutMs: 10000 }] });

  const { client, executorCalls } = makeClient(() => answer("should not run"));
  await assert.rejects(
    runAgent({ cfg: makeConfig(workspace), ollama: client, tools: new ToolRegistry(), prompt: "hi", emit: () => {} }),
    /SessionStart/,
  );
  assert.equal(executorCalls(), 0);
});

test("SessionEnd reports the real terminal reason on a cancelled run", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFile(workspace, "se_reason_fixture.js", SESSION_END_REASON_FIXTURE);
  writeHooks(workspace, { SessionEnd: [{ matcher: "", command: command(fixture), timeoutMs: 10000 }] });

  const controller = new AbortController();
  const { client } = makeClient(() => {
    controller.abort();
    return answer("still working");
  });
  await assert.rejects(
    runAgent({
      cfg: makeConfig(workspace),
      ollama: client,
      tools: new ToolRegistry(),
      prompt: "hi",
      signal: controller.signal,
      emit: () => {},
    }),
    /cancelled/,
  );

  const reason = fs.readFileSync(path.join(workspace, ".session-end-reason"), "utf8").trim();
  assert.equal(reason, "cancelled", "SessionEnd must not claim a completed session");
});

test("UserPromptSubmit additionalContext is injected into the first model call", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFile(workspace, "ups_context.js", `console.log(JSON.stringify({ additionalContext: 'PROMPT-CTX' }));`);
  writeHooks(workspace, { UserPromptSubmit: [{ matcher: "", command: command(fixture), timeoutMs: 10000 }] });

  const captured: string[] = [];
  const { client } = makeClient((_call, messages) => {
    captured.push(messages.map((m) => m.content).join("\n"));
    return answer("done");
  });
  await runAgent({ cfg: makeConfig(workspace), ollama: client, tools: new ToolRegistry(), prompt: "hi", emit: () => {} });
  assert.ok(captured[0]!.includes("PROMPT-CTX"), "UserPromptSubmit context reached the model");
});

test("Stop additionalContext is injected before the next loop step", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFile(
    workspace,
    "stop_context.js",
    `const fs = require('fs');\nconst path = require('path');\nconst ws = process.env.MANUS_WORKSPACE || process.cwd();\nconst counter = path.join(ws, '.stop-context-count');\nconst count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;\nif (count === 0) { fs.writeFileSync(counter, '1'); console.log(JSON.stringify({ decision: 'block', additionalContext: 'CONTINUE-CTX' })); } else { console.log('{}'); }`,
  );
  writeHooks(workspace, { Stop: [{ matcher: "", command: command(fixture), timeoutMs: 10000 }] });

  const captured: string[] = [];
  const { client } = makeClient((_call, messages) => {
    captured.push(messages.map((m) => m.content).join("\n"));
    return answer("all done");
  });
  const result = await runAgent({ cfg: makeConfig(workspace), ollama: client, tools: new ToolRegistry(), prompt: "do the thing", emit: () => {} });
  assert.equal(result.steps, 2);
  assert.ok(captured[1]!.includes("CONTINUE-CTX"), "Stop context reached the follow-up step");
});

test("a Stop hook with a non-matching matcher still runs", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFile(
    workspace,
    "stop_matcher.js",
    `const fs = require('fs');\nconst path = require('path');\nconst ws = process.env.MANUS_WORKSPACE || process.cwd();\nconst counter = path.join(ws, '.stop-matcher-count');\nconst count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;\nif (count === 0) { fs.writeFileSync(counter, '1'); console.log(JSON.stringify({ decision: 'block', reason: 'once' })); } else { console.log('{}'); }`,
  );
  writeHooks(workspace, { Stop: [{ matcher: "some-tool", command: command(fixture), timeoutMs: 10000 }] });

  const { client, executorCalls } = makeClient(() => answer("all done"));
  const result = await runAgent({ cfg: makeConfig(workspace), ollama: client, tools: new ToolRegistry(), prompt: "do the thing", emit: () => {} });
  assert.equal(result.steps, 2);
  assert.equal(executorCalls(), 2);
});

test("SubagentStart blocks delegate_subagent before it runs the child", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFile(workspace, "sub_block.js", `console.log(JSON.stringify({ decision: 'block', reason: 'no subagents' }));`);
  writeHooks(workspace, { SubagentStart: [{ matcher: "", command: command(fixture), timeoutMs: 10000 }] });

  const { createSubagentTools } = await import("../../tools/subagents.js");
  const tools = createSubagentTools({} as never, new ToolRegistry());
  const delegate = tools.find((t) => t.name === "delegate_subagent")!;
  const res = await delegate.run(
    { subagent: "explore", task: "look around" },
    { cfg: makeConfig(workspace), workspace, emit: () => {} },
  );
  assert.equal(res.ok, false);
  assert.match(res.content, /no subagents/);
});

test("SubagentStart additionalContext and SubagentStop both fire for delegate_subagent", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFile(
    workspace,
    "sub_events.js",
    `const fs = require('fs');\nconst path = require('path');\nconst ws = process.env.MANUS_WORKSPACE || process.cwd();\nfs.appendFileSync(path.join(ws, '.sub-log'), (process.env.MANUS_HOOK_EVENT || '?') + '\\n');\nif (process.env.MANUS_HOOK_EVENT === 'SubagentStart') console.log(JSON.stringify({ additionalContext: 'SUB-CTX' }));\n`,
  );
  writeHooks(workspace, {
    SubagentStart: [{ matcher: "", command: command(fixture), timeoutMs: 10000 }],
    SubagentStop: [{ matcher: "", command: command(fixture), timeoutMs: 10000 }],
  });

  const { createSubagentTools } = await import("../../tools/subagents.js");
  const { ToolRegistry } = await import("../../tools/registry.js");
  const captured: string[] = [];
  const { client } = makeClient((_call, messages) => {
    captured.push(messages.map((m) => m.content).join("\n"));
    return answer("child result");
  });
  const tools = createSubagentTools(client, new ToolRegistry());
  const delegate = tools.find((t) => t.name === "delegate_subagent")!;

  const res = await delegate.run(
    { subagent: "explore", task: "look around" },
    { cfg: makeConfig(workspace), workspace, emit: () => {} },
  );
  assert.equal(res.ok, true);
  assert.ok(captured[0]!.includes("SUB-CTX"), "SubagentStart context reached the child");
  const events = fs.readFileSync(path.join(workspace, ".sub-log"), "utf8").trim().split(/\r?\n/);
  assert.ok(events.includes("SubagentStart"), "SubagentStart fired");
  assert.ok(events.includes("SubagentStop"), "SubagentStop fired");
});
