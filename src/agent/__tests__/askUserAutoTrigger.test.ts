/**
 * N9 acceptance tests — the orchestrator's Ask-User-More auto-trigger.
 *
 * The Neo reference says Ask User More "fires automatically when the prompt is
 * vague or context is missing". These tests drive the real orchestrated run with
 * a fake model and no network calls, and assert the two acceptance criteria:
 *
 *   - a vague prompt raises an `ask_user_required` event BEFORE the planner (and
 *     therefore before any tool call), and nothing is planned while it waits;
 *   - once the user answers, the run continues and the answer (including an
 *     uploaded file path) is attached to the prompt the planner sees;
 *   - a concrete prompt never raises a card.
 */
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../../config.js";
import { runOrchestratedAgent } from "../orchestrator.js";
import { answerAskUser, dismissAskUser, pendingAskForTask } from "../../tools/askUserStore.js";
import type { AgentEvent } from "../events.js";
import type { ChatMessage, ChatOptions, ChatResult, OllamaClient } from "../../ollama.js";
import type { CooldownStore, FailoverProvider } from "../../llm/failover.js";
import { ToolRegistry } from "../../tools/registry.js";

type Role = "planner" | "critic" | "final" | "worker";

function roleOf(messages: ChatMessage[]): Role {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  if (system.includes("planner role")) return "planner";
  if (system.includes("COMPLETED task as a whole")) return "final";
  if (system.includes("ONE executed plan step")) return "critic";
  return "worker";
}

function fakeOllama(): { client: OllamaClient; prompts: string[] } {
  const prompts: string[] = [];
  const client = {
    async chat(options: ChatOptions): Promise<ChatResult> {
      const last = options.messages[options.messages.length - 1];
      if (last) prompts.push(last.content);
      const role = roleOf(options.messages);
      const content =
        role === "planner"
          ? JSON.stringify({
              goal: "finish the request",
              trivial: true,
              steps: [{ id: "s1", title: "do it", instruction: "answer", success_criteria: "answer returned" }],
            })
          : role === "worker"
            ? "the answer"
            : JSON.stringify({ verdict: "pass", reason: "criteria met", fixes: [] });
      return { content, toolCalls: [], model: options.model, usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
    },
    async listModels(): Promise<string[]> {
      return [];
    },
  } as unknown as OllamaClient;
  return { client, prompts };
}

function memoryStore(): CooldownStore {
  const map = new Map<string, { expiresAt: number; backoffCount: number }>();
  return {
    get: (key) => map.get(key),
    set: (key, entry) => void map.set(key, entry),
    entries: () => [...map.entries()],
    save: () => {},
  };
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
  cfg.coding = { enabled: true, chain: [], logEdits: false };
  cfg.failover = { providers: [] };
  return cfg;
}

function routingSeams(workspace: string, client: OllamaClient) {
  return {
    createProviderClient: (_provider: FailoverProvider) => client as never,
    cooldownStore: memoryStore(),
    env: {} as Record<string, string | undefined>,
    onCodingRoute: () => {},
    cfg: testConfig(workspace),
  };
}

/** Wait for the run's auto-trigger to register its pending request. */
async function waitForPending(taskId: string) {
  for (let i = 0; i < 300; i++) {
    const found = pendingAskForTask(taskId);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

/** Hold the event loop open while a run waits on an unref'd poll timer. */
async function withKeepAlive<T>(fn: () => Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {}, 25);
  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
  }
}

test("a vague prompt raises the ask-user card before anything is planned", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-ask-auto-"));
  const { client, prompts } = fakeOllama();
  const events: AgentEvent[] = [];
  const taskId = "task_auto_vague";

  const run = runOrchestratedAgent({
    ...routingSeams(workspace, client),
    ollama: client,
    tools: new ToolRegistry(),
    prompt: "refactor and optimize the codebase",
    taskId,
    emit: (event) => events.push(event),
  });

  await withKeepAlive(async () => {
    const pending = await waitForPending(taskId);
    assert.ok(pending, "a vague prompt must raise a clarification request");
    assert.equal(pending!.taskId, taskId);
    assert.ok(pending!.questions.length >= 1);

    // The card event fires before the planner is ever called.
    const asked = events.find((e) => e.type === "ask_user_required");
    assert.ok(asked, "an ask_user_required event must reach the client");
    assert.equal((asked as { askUserId: string }).askUserId, pending!.id);
    assert.equal(prompts.length, 0, "nothing may be planned while the card waits");

    answerAskUser(pending!.id, { text: "Only the parser module.", answers: {}, files: [] });
    await run;
  });

  assert.ok(prompts.length > 0, "the run must continue after the answer");
  assert.ok(
    prompts.some((p) => p.includes("Only the parser module.")),
    "the user's answer must reach the planner as context",
  );
});

test("an answer with an uploaded file resumes the run with the file path attached", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-ask-file-"));
  const { client, prompts } = fakeOllama();
  const taskId = "task_auto_file";

  const run = runOrchestratedAgent({
    ...routingSeams(workspace, client),
    ollama: client,
    tools: new ToolRegistry(),
    prompt: "make the same change as before",
    taskId,
    emit: () => {},
  });

  await withKeepAlive(async () => {
    const pending = await waitForPending(taskId);
    assert.ok(pending, "a missing-context prompt must raise a clarification request");
    answerAskUser(pending!.id, {
      text: "",
      answers: { q1: "The attached spec" },
      files: [{ path: `uploads/${pending!.id}/spec.pdf`, name: "spec.pdf", bytes: 12, contentType: "application/pdf" }],
    });
    await run;
  });

  const plannerPrompt = prompts[0] ?? "";
  assert.match(plannerPrompt, /make the same change as before/);
  assert.match(plannerPrompt, /The attached spec/);
  assert.match(plannerPrompt, /spec\.pdf/);
  assert.match(plannerPrompt, /uploads\/ask_/);
});

test("a dismissed card lets the run continue and states its assumptions", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-ask-dismiss-"));
  const { client, prompts } = fakeOllama();
  const taskId = "task_auto_dismiss";

  const run = runOrchestratedAgent({
    ...routingSeams(workspace, client),
    ollama: client,
    tools: new ToolRegistry(),
    prompt: "refactor and optimize the codebase",
    taskId,
    emit: () => {},
  });

  await withKeepAlive(async () => {
    const pending = await waitForPending(taskId);
    assert.ok(pending);
    dismissAskUser(pending!.id);
    await run;
  });

  assert.ok(prompts.length > 0, "a dismissed card must not park the run");
  assert.ok(
    prompts.some((p) => p.includes("state your assumptions")),
    "the run must be told the user did not answer and to state its assumptions",
  );
});

test("a concrete prompt never raises a card", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-ask-concrete-"));
  const { client, prompts } = fakeOllama();
  const events: AgentEvent[] = [];
  const taskId = "task_auto_concrete";

  await runOrchestratedAgent({
    ...routingSeams(workspace, client),
    ollama: client,
    tools: new ToolRegistry(),
    prompt: "Add a snapshot test to src/parser.test.ts",
    taskId,
    emit: (event) => events.push(event),
  });

  assert.equal(events.some((e) => e.type === "ask_user_required"), false, "a concrete request must not be interrupted");
  assert.equal(pendingAskForTask(taskId), undefined);
  assert.ok(prompts.length > 0, "the run proceeds straight to planning");
});
