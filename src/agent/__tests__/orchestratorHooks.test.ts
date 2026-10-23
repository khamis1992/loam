/**
 * Coverage for the session lifecycle boundary of the orchestrated run path.
 *
 * A top-level orchestrated task must see SessionStart, UserPromptSubmit, Stop and
 * SessionEnd exactly like the plain agent loop does. Nested runs (orchestrator
 * workers) must stay silent, and the SessionEnd reason must be truthful.
 */
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../../config.js";
import { runOrchestratedAgent } from "../orchestrator.js";
import type { ChatMessage, ChatOptions, ChatResult, OllamaClient } from "../../ollama.js";
import type { CooldownStore, FailoverProvider } from "../../llm/failover.js";
import { ToolRegistry } from "../../tools/registry.js";

type Role = "planner" | "critic" | "final" | "worker";

interface FakeResponse {
  content: string;
}

function roleOf(messages: ChatMessage[]): Role {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  if (system.includes("planner role")) return "planner";
  if (system.includes("COMPLETED task as a whole")) return "final";
  if (system.includes("ONE executed plan step")) return "critic";
  return "worker";
}

/** Fake model that walks a trivial plan to a passing verdict. */
function fakeOllama(handler: (role: Role, call: number) => FakeResponse = () => ({ content: "{}" })): {
  client: OllamaClient;
  counts: Record<Role, number>;
  prompts: string[];
} {
  const counts: Record<Role, number> = { planner: 0, critic: 0, final: 0, worker: 0 };
  const prompts: string[] = [];
  const client = {
    async chat(options: ChatOptions): Promise<ChatResult> {
      const role = roleOf(options.messages);
      counts[role] += 1;
      const last = options.messages[options.messages.length - 1];
      if (last) prompts.push(last.content);
      const resp = handler(role, counts[role]);
      return {
        content: resp.content,
        toolCalls: [],
        model: options.model,
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      };
    },
    async listModels(): Promise<string[]> {
      return [];
    },
  } as unknown as OllamaClient;
  return { client, counts, prompts };
}

function planJson(): string {
  return JSON.stringify({
    goal: "finish the request",
    trivial: true,
    steps: [{ id: "s1", title: "do it", instruction: "echo hi", success_criteria: "answer returned" }],
  });
}

function verdictJson(verdict: string, reason: string): string {
  return JSON.stringify({ verdict, reason, fixes: [] });
}

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loam-orch-hooks-"));
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

/** In-memory cooldown store: a failing provider must not leave a process-wide
 *  mark behind, and routing must not touch the real data folder. */
function memoryStore(): CooldownStore {
  const map = new Map<string, { expiresAt: number; backoffCount: number }>();
  return {
    get: (key) => map.get(key),
    set: (key, entry) => void map.set(key, entry),
    entries: () => [...map.entries()],
    save: () => {},
  };
}

function command(file: string): string {
  return `node "${file}"`;
}

function testConfig(workspace: string): Config {
  const cfg = loadConfig();
  cfg.workspace = workspace;
  cfg.orchestrator = {
    enabled: true,
    plannerModel: "",
    verifierModel: "",
    maxPlanSteps: 8,
    maxStepsPerWorker: 6,
    maxRevisionsPerStep: 1,
    maxReplans: 1,
    verifyFinal: true,
  };
  // Keep these tests hermetic: no provider may serve a coding turn from the
  // network. `createProviderClient` hands the router the same fake the rest of
  // the run uses, so a worker that is itself a coding turn (a Stop continuation
  // names the hook script and the answer) is answered by the fake instead of
  // escaping to the real provider chain.
  cfg.coding = { enabled: true, chain: [], logEdits: false };
  cfg.failover = { providers: [] };
  return cfg;
}

/** Routing seams shared by every test: no real provider, no real cooldown
 *  store, no real environment. The Stop-continuation prompt trips the coding
 *  heuristic, so the worker would otherwise be routed to the network. */
function routingSeams(workspace: string, client: OllamaClient) {
  return {
    createProviderClient: (_provider: FailoverProvider) => client as never,
    cooldownStore: memoryStore(),
    env: {} as Record<string, string | undefined>,
    onCodingRoute: () => {},
    cfg: testConfig(workspace),
  };
}

test("an orchestrated run fires SessionStart, UserPromptSubmit and SessionEnd", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFile(
    workspace,
    "orch_session.js",
    `const fs = require('fs');\nconst path = require('path');\nconst ws = process.env.MANUS_WORKSPACE || process.cwd();\nfs.appendFileSync(path.join(ws, '.orch-hook-log'), (process.env.MANUS_HOOK_EVENT || '?') + '\\n');\nif (process.env.MANUS_HOOK_EVENT === 'UserPromptSubmit') console.log(JSON.stringify({ additionalContext: 'ORCH-PROMPT-CTX' }));\n`,
  );
  writeHooks(workspace, {
    SessionStart: [{ matcher: "", command: command(fixture), timeoutMs: 10000 }],
    UserPromptSubmit: [{ matcher: "", command: command(fixture), timeoutMs: 10000 }],
    SessionEnd: [{ matcher: "", command: command(fixture), timeoutMs: 10000 }],
  });

  const { client, prompts } = fakeOllama((role) => {
    if (role === "planner") return { content: planJson() };
    if (role === "worker") return { content: "the answer" };
    return { content: verdictJson("pass", "criteria met") };
  });

  await runOrchestratedAgent({
    ...routingSeams(workspace, client),
    ollama: client,
    tools: new ToolRegistry(),
    prompt: "echo hi",
    lifecycleHooks: true,
    emit: () => {},
  });

  const events = fs.readFileSync(path.join(workspace, ".orch-hook-log"), "utf8").trim().split(/\r?\n/);
  assert.ok(events.includes("SessionStart"), "SessionStart fired for the orchestrated run");
  assert.ok(events.includes("UserPromptSubmit"), "UserPromptSubmit fired for the orchestrated run");
  assert.ok(events.includes("SessionEnd"), "SessionEnd fired for the orchestrated run");
  assert.ok(
    prompts.some((p) => p.includes("ORCH-PROMPT-CTX")),
    "UserPromptSubmit context reached the planner",
  );
});

test("nested orchestrated runs stay silent without lifecycleHooks", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFile(
    workspace,
    "orch_nested.js",
    `const fs = require('fs');\nconst path = require('path');\nfs.appendFileSync(path.join(process.env.MANUS_WORKSPACE || process.cwd(), '.nested-log'), (process.env.MANUS_HOOK_EVENT || '?') + '\\n');\n`,
  );
  writeHooks(workspace, {
    SessionStart: [{ matcher: "", command: command(fixture), timeoutMs: 10000 }],
    UserPromptSubmit: [{ matcher: "", command: command(fixture), timeoutMs: 10000 }],
    SessionEnd: [{ matcher: "", command: command(fixture), timeoutMs: 10000 }],
  });

  const { client } = fakeOllama((role) => {
    if (role === "planner") return { content: planJson() };
    if (role === "worker") return { content: "the answer" };
    return { content: verdictJson("pass", "criteria met") };
  });

  await runOrchestratedAgent({
    ...routingSeams(workspace, client),
    ollama: client,
    tools: new ToolRegistry(),
    prompt: "echo hi",
    emit: () => {},
  });

  assert.equal(fs.existsSync(path.join(workspace, ".nested-log")), false, "nested runs must not fire session hooks");
});

test("a blocked Stop forces the orchestrated run to keep working", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFile(
    workspace,
    "orch_stop.js",
    `const fs = require('fs');\nconst path = require('path');\nconst ws = process.env.MANUS_WORKSPACE || process.cwd();\nconst counter = path.join(ws, '.orch-stop-count');\nconst count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;\nif (count === 0) { fs.writeFileSync(counter, '1'); console.log(JSON.stringify({ decision: 'block', reason: 'one more pass' })); } else { console.log('{}'); }`,
  );
  writeHooks(workspace, { Stop: [{ matcher: "", command: command(fixture), timeoutMs: 10000 }] });

  const { client, counts } = fakeOllama((role) => {
    if (role === "planner") return { content: planJson() };
    if (role === "worker") return { content: "the answer" };
    if (role === "critic") return { content: verdictJson("pass", "step criteria met") };
    return { content: verdictJson("pass", "criteria met") };
  });

  await runOrchestratedAgent({
    ...routingSeams(workspace, client),
    ollama: client,
    tools: new ToolRegistry(),
    prompt: "echo hi",
    lifecycleHooks: true,
    emit: () => {},
  });

  assert.ok(counts.worker >= 2, "the blocked Stop must cause another worker round");
  assert.ok(fs.existsSync(path.join(workspace, ".orch-stop-count")), "the Stop hook ran");
});

test("SessionEnd reports cancelled for an aborted orchestrated run", async () => {
  const workspace = makeWorkspace();
  const fixture = writeFile(
    workspace,
    "orch_reason.js",
    `const fs = require('fs');\nconst path = require('path');\nfs.writeFileSync(\n  path.join(process.env.MANUS_WORKSPACE || process.cwd(), '.orch-session-end-reason'),\n  process.env.MANUS_ARG_reason || 'unknown',\n);\n`,
  );
  writeHooks(workspace, { SessionEnd: [{ matcher: "", command: command(fixture), timeoutMs: 10000 }] });

  const controller = new AbortController();
  const { client } = fakeOllama((role) => {
    controller.abort();
    if (role === "planner") return { content: planJson() };
    return { content: verdictJson("pass", "criteria met") };
  });

  await assert.rejects(
    runOrchestratedAgent({
      ...routingSeams(workspace, client),
      ollama: client,
      tools: new ToolRegistry(),
      prompt: "echo hi",
      signal: controller.signal,
      lifecycleHooks: true,
      emit: () => {},
    }),
    /cancelled/i,
  );

  const reason = fs.readFileSync(path.join(workspace, ".orch-session-end-reason"), "utf8").trim();
  assert.equal(reason, "cancelled", "SessionEnd must not claim a completed session");
});

test("a Stop continuation answer is verified again before the run finishes", async () => {
  const workspace = makeWorkspace();
  // Blocks on the first Stop and approves afterwards, so the run reaches the
  // continuation exactly once.
  const fixture = writeFile(
    workspace,
    "orch_stop_once.js",
    `const fs = require('fs');\nconst path = require('path');\nconst ws = process.env.MANUS_WORKSPACE || process.cwd();\nconst flag = path.join(ws, '.orch-stop-blocked');\nif (fs.existsSync(flag)) { console.log('{}'); }\nelse { fs.writeFileSync(flag, '1'); console.log(JSON.stringify({ decision: 'block', reason: 'verify the revised answer' })); }\n`,
  );
  writeHooks(workspace, { Stop: [{ matcher: "", command: command(fixture), timeoutMs: 10000 }] });

  const { client, counts } = fakeOllama((role) => {
    if (role === "planner") return { content: planJson() };
    if (role === "worker") return { content: "revised answer" };
    if (role === "critic") return { content: verdictJson("pass", "step criteria met") };
    return { content: verdictJson("pass", "criteria met") };
  });

  const result = await runOrchestratedAgent({
    ...routingSeams(workspace, client),
    ollama: client,
    tools: new ToolRegistry(),
    prompt: "echo hi",
    lifecycleHooks: true,
    emit: () => {},
  });

  assert.equal(counts.final, 2, "the revised answer must be verified a second time");
  assert.equal(result.text, "revised answer", "the re-verified answer is returned");
});
