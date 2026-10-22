/**
 * Task C14: custom subagents from the repo.
 *
 * `.loam/agents/*.md` (plus agents/*.md and .claude/agents/*.md) define named
 * subagents with frontmatter (name, description, tools, model). `delegate_task`
 * selects one via `subagent_type` and runs it in-process with only its final
 * report returned to the parent. The agent's `tools` allowlist is enforced:
 * a fixture agent restricted to `file_read, file_list` can never call
 * `file_write`, and it cannot re-delegate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSubagentToolRegistry,
  createSubagentTools,
  discoverSubagents,
  findSubagentProfile,
} from "../subagents.js";
import { ToolRegistry, type ToolContext } from "../registry.js";
import type { ChatMessage, ChatResult, OllamaClient } from "../../ollama.js";
import type { Config } from "../../config.js";

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "loam-subagent-custom-"));
const AGENTS_DIR = path.join(WORKSPACE, ".loam", "agents");

function writeFixture(name: string, body: string): void {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(AGENTS_DIR, name), body, "utf8");
}

writeFixture(
  "restricted.md",
  [
    "---",
    "name: restricted",
    "description: Fixture agent with a restricted tool list",
    "tools: file_read, file_list",
    "model: fake-model",
    "---",
    "",
    "You are the restricted fixture. Use only the tools you are given.",
    "",
  ].join("\n"),
);

writeFixture(
  "blocked.md",
  [
    "---",
    "name: blocked",
    "description: Fixture using a YAML block list for tools",
    "tools:",
    "  - file_read",
    "  - file_search",
    "---",
    "",
    "Body of the block-list fixture.",
    "",
  ].join("\n"),
);

function makeConfig(): Config {
  return {
    model: "fake-model",
    fallbackModel: "",
    agent: { maxSteps: 40, temperature: 0.2, requestTimeoutMs: 60000 },
    workspace: WORKSPACE,
    policy: {
      networkEnabled: false,
      allowOutsideWorkspaceRead: false,
      denyCommandPatterns: [],
      allowCommandPatterns: [],
      maxCommandSeconds: 180,
      sandboxMode: "workspace-write",
    },
    vision: { enabled: false, maxImagesPerStep: 2 },
    compression: {
      enabled: false,
      thresholdPercent: 0.5,
      protectLead: 3,
      protectTail: 20,
      targetRatio: 0.2,
      model: "",
      contextWindow: {},
    },
    subagent: { maxDepth: 2, maxConcurrentChildren: 4 },
  } as unknown as Config;
}

function ctxFor(): ToolContext {
  return { cfg: makeConfig(), workspace: WORKSPACE, emit: () => {} };
}

function usage() {
  return { promptTokens: 1, completionTokens: 1, durationMs: 1 };
}

function toolResult(name: string): ChatResult["toolCalls"][number] {
  return { function: { name, arguments: {} } };
}

test("discoverSubagents loads .loam/agents frontmatter (inline and block lists)", () => {
  const profiles = discoverSubagents(WORKSPACE);

  const restricted = profiles.find((p) => p.name === "restricted");
  assert.ok(restricted, "restricted profile is discovered");
  assert.equal(restricted!.source, "file");
  assert.equal(restricted!.description, "Fixture agent with a restricted tool list");
  assert.deepEqual(restricted!.allowTools, ["file_read", "file_list"]);
  assert.equal(restricted!.model, "fake-model");
  assert.match(restricted!.instructions, /restricted fixture/);

  const blocked = profiles.find((p) => p.name === "blocked");
  assert.ok(blocked, "block-list profile is discovered");
  assert.deepEqual(blocked!.allowTools, ["file_read", "file_search"]);
});

test("buildSubagentToolRegistry drops non-allowlisted tools and blocks re-delegation", async () => {
  const parent = new ToolRegistry();
  for (const name of ["file_read", "file_list", "file_write", "delegate_task", "delegate_subagent"]) {
    parent.register({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      async run() {
        return { ok: true, content: name };
      },
    });
  }

  const profile = findSubagentProfile(WORKSPACE, "restricted");
  assert.ok(profile, "restricted profile resolves by name");
  const sub = buildSubagentToolRegistry(parent, profile!);

  assert.deepEqual(sub.names(), ["file_list", "file_read"]);
  assert.equal(sub.get("file_write"), undefined);
  assert.equal(sub.get("delegate_task"), undefined);
  assert.equal(sub.get("delegate_subagent"), undefined);

  const rejected = await sub.exec("file_write", { path: "out.txt", content: "x" }, ctxFor());
  assert.equal(rejected.ok, false);
  assert.match(rejected.content, /unknown tool "file_write"/);
});

test("delegate_task subagent_type: a restricted fixture agent cannot call an excluded tool", async () => {
  const parent = new ToolRegistry();
  let writeCalls = 0;
  parent.register({
    name: "file_read",
    description: "read",
    parameters: { type: "object", properties: {} },
    async run() {
      return { ok: true, content: "read-ok" };
    },
  });
  parent.register({
    name: "file_list",
    description: "list",
    parameters: { type: "object", properties: {} },
    async run() {
      return { ok: true, content: "list-ok" };
    },
  });
  parent.register({
    name: "file_write",
    description: "write",
    parameters: { type: "object", properties: {} },
    async run() {
      writeCalls += 1;
      return { ok: true, content: "write-ok" };
    },
  });

  const seen: ChatMessage[][] = [];
  const turns: ChatResult[] = [
    { content: "", model: "fake-model", toolCalls: [toolResult("file_write")], usage: usage() },
    { content: "I could not write the file because that tool is unavailable.", model: "fake-model", toolCalls: [], usage: usage() },
  ];
  let i = 0;
  const ollama = {
    chat: async (opts: { messages: ChatMessage[] }) => {
      seen.push(opts.messages);
      return turns[Math.min(i++, turns.length - 1)]!;
    },
  } as unknown as OllamaClient;

  const delegate = createSubagentTools(ollama, parent).find((t) => t.name === "delegate_task")!;
  const res = await delegate.run({ subagent_type: "restricted", prompt: "Write out.txt." }, ctxFor());

  assert.equal(res.ok, true, res.content);
  assert.equal(writeCalls, 0, "the excluded file_write tool must never execute");
  const rejected = seen[1]?.find((m) => m.role === "tool" && m.tool_name === "file_write");
  assert.ok(rejected, "the model's file_write call must be answered");
  assert.match(rejected!.content, /unknown tool "file_write"/);
  assert.match(res.content, /I could not write the file/);
});

test("delegate_task subagent_type: an allowlisted tool is callable and only the report returns", async () => {
  const parent = new ToolRegistry();
  let readCalls = 0;
  parent.register({
    name: "file_read",
    description: "read",
    parameters: { type: "object", properties: {} },
    async run() {
      readCalls += 1;
      return { ok: true, content: "read-ok" };
    },
  });
  parent.register({
    name: "file_write",
    description: "write",
    parameters: { type: "object", properties: {} },
    async run() {
      return { ok: true, content: "write-ok" };
    },
  });

  const seen: ChatMessage[][] = [];
  const turns: ChatResult[] = [
    { content: "", model: "fake-model", toolCalls: [toolResult("file_read")], usage: usage() },
    { content: "Done reading.", model: "fake-model", toolCalls: [], usage: usage() },
  ];
  let i = 0;
  const ollama = {
    chat: async (opts: { messages: ChatMessage[] }) => {
      seen.push(opts.messages);
      return turns[Math.min(i++, turns.length - 1)]!;
    },
  } as unknown as OllamaClient;

  const delegate = createSubagentTools(ollama, parent).find((t) => t.name === "delegate_task")!;
  const res = await delegate.run({ subagent_type: "restricted", prompt: "Read a.txt." }, ctxFor());

  assert.equal(res.ok, true, res.content);
  assert.equal(readCalls, 1, "the allowlisted file_read tool executes");
  const ok = seen[1]?.find((m) => m.role === "tool" && m.tool_name === "file_read");
  assert.ok(ok, "the allowlisted tool result is fed back");
  assert.match(ok!.content, /read-ok/);
  assert.match(res.content, /\[Subagent "restricted" finished/);
  assert.match(res.content, /Done reading\./);
});

test("delegate_task rejects an unknown subagent_type without running anything", async () => {
  const parent = new ToolRegistry();
  const ollama = { chat: async () => ({ content: "", toolCalls: [], model: "fake-model", usage: usage() }) } as unknown as OllamaClient;
  const delegate = createSubagentTools(ollama, parent).find((t) => t.name === "delegate_task")!;

  const res = await delegate.run({ subagent_type: "does-not-exist", prompt: "x" }, ctxFor());
  assert.equal(res.ok, false);
  assert.match(res.content, /unknown subagent_type "does-not-exist"/);
  assert.match(res.content, /restricted/);
});
