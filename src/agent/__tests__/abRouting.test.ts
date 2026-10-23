/**
 * Neo N10: multi-model A/B arms on the run graph.
 *
 * The router decides *which* models are compared (llm/__tests__/router.test.ts) and
 * the graph decides *how* an arm is stored (graph/__tests__/runGraph.test.ts). These
 * tests cover the boundary between them: that a run carrying `abModels` records one
 * sibling arm per model off the run's root node **and actually runs that model**,
 * so the arm's node ends in a terminal state carrying the answer that model
 * produced, and that a graph failure is logged instead of failing the task.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { Config } from "../../config.js";
import type { ChatResult, OllamaClient, OllamaToolCall } from "../../ollama.js";
import type { Emit } from "../events.js";
import type { Tool } from "../../tools/registry.js";

// DATA_DIR is a module-level constant in config.ts, and the graph adapter opens a
// SQLite file under it. Point it at a temp folder *before* any value import that
// transitively loads config, so these tests never touch the repository's data dir.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-ab-routing-"));
process.env.MANUS_LOCAL_DATA_DIR = path.join(tmp, "data");

const { runAgent } = await import("../loop.js");
const { ToolRegistry: RegistryCtor } = await import("../../tools/registry.js");
const { getRunNodes, clearRun, beginRun } = await import("../runGraphAdapter.js");
const { closeDb } = await import("../../server/sqliteStore.js");

type ToolRegistry = import("../../tools/registry.js").ToolRegistry;

let workspace = "";

before(() => {
  workspace = path.join(tmp, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
});

after(() => {
  // Release the lazily-opened SQLite handle before deleting the temp data dir;
  // on Windows an open handle makes the removal fail with EPERM.
  closeDb();
  delete process.env.MANUS_LOCAL_DATA_DIR;
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    console.error(`[abRouting] temp cleanup failed: ${String(err)}`);
  }
});

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    model: "weak-default",
    fallbackModel: "",
    ollamaUrl: "http://localhost:11434",
    server: { host: "127.0.0.1", port: 3939 },
    agent: { maxSteps: 6, temperature: 0.2, requestTimeoutMs: 600000 },
    workspace,
    policy: {
      networkEnabled: false,
      allowOutsideWorkspaceRead: true,
      denyCommandPatterns: [],
      allowCommandPatterns: [],
      maxCommandSeconds: 180,
      sandboxMode: "workspace-write",
    },
    browser: { channel: "msedge", headless: true, viewport: { width: 1280, height: 800 } },
    computerUse: { enabled: false, screenshotDir: "/tmp/screenshots" },
    memory: { enabled: false, model: "", file: "", autoStore: false, recallTop: 0, minScore: 0, maxEntries: 0, dedupeThreshold: 0 },
    screen: { enabled: false, fps: 1, quality: 60, maxWidth: 1280 },
    vision: { enabled: false, maxImagesPerStep: 0 },
    selfImprove: { enabled: false, reviewEvery: 1, model: "", maxSteps: 1, writeApproval: false },
    evaluation: { enabled: false, intervalMinutes: 360, suite: "core", critique: false, keepRuns: 0, transcripts: false },
    selfPlay: { maxCases: 0 },
    orchestrator: { enabled: false, plannerModel: "", verifierModel: "", maxPlanSteps: 1, maxStepsPerWorker: 1, maxRevisionsPerStep: 1, maxReplans: 1, verifyFinal: false },
    mcpServers: {},
    compression: { enabled: false, thresholdPercent: 0.5, protectLead: 3, protectTail: 20, targetRatio: 0.2, model: "", contextWindow: {} },
    sessionLog: { enabled: false },
    subagent: { maxDepth: 2, maxConcurrentChildren: 4 },
    coding: { enabled: true, chain: ["weak-default"], logEdits: false },
    ...overrides,
  } as unknown as Config;
}

/** A `file_read` tool: enough to satisfy the registry without touching the network. */
function readTool(): Tool {
  return {
    name: "file_read",
    description: "Read a file from the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    async run() {
      return { ok: true, content: "empty" };
    },
  };
}

function registry(): ToolRegistry {
  const base = new RegistryCtor();
  base.registerAll([readTool()]);
  return base.forAllowlist(["file_read"]);
}

/**
 * Fake client with two roles, distinguished by the system prompt it is handed:
 * the agent's own turn answers with a tool-free "done" (which stops the loop after
 * one step), while the independent final verifier answers with a valid `pass`
 * verdict. A real model API is never contacted.
 *
 * Every call records the model it was asked for, so a test can prove that an A/B
 * arm was actually dispatched to *its own* model rather than merely recorded.
 */
function chatClient(model = "weak-default", calls: string[] = []): OllamaClient {
  return {
    async chat(options: { model?: string; messages?: Array<{ role: string; content: string }> }): Promise<ChatResult> {
      const requested = options.model ?? model;
      calls.push(requested);
      const system = options.messages?.find((message) => message.role === "system")?.content ?? "";
      const verifier = system.includes("verdict") || system.includes("finalAnswer");
      return verifier
        ? {
            content: JSON.stringify({ verdict: "pass", reason: "nothing to check in this fake run", fixes: [] }),
            toolCalls: [] as OllamaToolCall[],
            model,
            usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
          }
        : { content: `done by ${requested}`, toolCalls: [] as OllamaToolCall[], model: requested, usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
    },
  } as unknown as OllamaClient;
}

/** A client whose every call fails, so an arm can be shown to fail in isolation. */
function failingClient(): OllamaClient {
  return {
    async chat(): Promise<ChatResult> {
      throw new Error("model unavailable");
    },
  } as unknown as OllamaClient;
}

describe("runAgent multi-model A/B", () => {
  it("records one sibling arm per model and runs each arm's own model", async () => {
    const taskId = "task_ab_1";
    beginRun(taskId, "Compare models");
    const events: Array<{ type: string; text: string }> = [];
    const armCalls: string[] = [];

    const result = await runAgent({
      cfg: cfg(),
      ollama: chatClient("weak-default", armCalls),
      tools: registry(),
      emit: ((event: { type: string; text?: string }) => {
        events.push({ type: event.type, text: typeof event.text === "string" ? event.text : "" });
      }) as Emit,
      prompt: "Summarise the quarter",
      suppressFinal: false,
      maxSteps: 3,
      taskId,
      abModels: ["glm-5.4-flash:cloud", "qwen3-coder-30b"],
    });

    assert.equal(result.text, "done by weak-default", "the run itself still completes");
    const nodes = getRunNodes(taskId);
    const arms = nodes.filter((node) => node.type === "sibling");
    assert.equal(arms.length, 2, "one arm per model");

    const root = nodes.find((node) => node.type === "question");
    assert.ok(root, "the run has a root node");
    for (const arm of arms) {
      assert.deepEqual(arm.parent_ids, [root!.id], "each arm hangs off the run's root");
      const model = (arm.data as { model?: string }).model;
      assert.ok(["glm-5.4-flash:cloud", "qwen3-coder-30b"].includes(model ?? ""), `unexpected arm model ${model}`);
      // Model ids only: the arms must never carry provider keys.
      assert.ok(!JSON.stringify(arm).includes("apiKey"), "an arm never carries key material");
    }
    const announced = events.filter((event) => event.text.startsWith("A/B arm started on"));
    assert.equal(announced.length, 2, "each arm is announced to the session");

    // The defect this covers: an arm used to be *recorded* but never executed, so
    // it stayed `init` and its model was never called. Now every arm is dispatched
    // to its own model and lands in a terminal state carrying that model's answer.
    const finished = events.filter((event) => event.text.startsWith("A/B arm finished on"));
    assert.equal(finished.length, 2, "each arm actually ran its model and finished");
    for (const model of ["glm-5.4-flash:cloud", "qwen3-coder-30b"]) {
      assert.ok(armCalls.includes(model), `arm model ${model} was actually dispatched`);
    }
    assert.ok(armCalls.includes("weak-default"), "the main run's own model is dispatched too");
    for (const arm of arms) {
      const data = arm.data as { answer?: string; model?: string };
      assert.equal(arm.status, "finished", `arm ${data.model} finished`);
      assert.equal(data.answer, `done by ${data.model}`, `arm ${data.model} stored its own answer`);
    }

    clearRun(taskId);
  });

  it("marks a failed arm failed without failing the run that owns it", async () => {
    const taskId = "task_ab_4";
    beginRun(taskId, "Compare models, one arm is down");

    // The main run's own model call fails too, so the run rejects. What matters is
    // that the arm failure is contained on its own node instead of surfacing as an
    // unhandled rejection or a node stuck in `running`.
    await assert.rejects(
      () => runAgent({
        cfg: cfg(),
        ollama: failingClient(),
        tools: registry(),
        emit: (() => {}) as Emit,
        prompt: "Summarise the quarter",
        suppressFinal: false,
        maxSteps: 3,
        taskId,
        abModels: ["model-a", "model-b"],
      }),
      /model unavailable/,
    );

    const arms = getRunNodes(taskId).filter((node) => node.type === "sibling");
    assert.equal(arms.length, 2, "both arms were recorded");
    for (const arm of arms) {
      const data = arm.data as { error?: string };
      assert.equal(arm.status, "failed", "an unreachable arm fails on its own node");
      assert.ok(typeof data.error === "string" && data.error.includes("unavailable"), "the arm records why it failed");
    }
    clearRun(taskId);
  });

  it("skips the arms when the run is asked to suppress its final turn", async () => {
    const taskId = "task_ab_2";
    beginRun(taskId, "Compare models quietly");

    await runAgent({
      cfg: cfg(),
      ollama: chatClient(),
      tools: registry(),
      emit: (() => {}) as Emit,
      prompt: "Summarise the quarter",
      suppressFinal: true,
      maxSteps: 3,
      taskId,
      abModels: ["model-a", "model-b"],
    });

    // `suppressFinal` is the subagent path: a child run must not grow the parent's
    // canvas with arms it was never asked to compare.
    assert.equal(getRunNodes(taskId).filter((node) => node.type === "sibling").length, 0);
    clearRun(taskId);
  });

  it("runs normally when no models are compared", async () => {
    const taskId = "task_ab_3";
    beginRun(taskId, "A plain run");

    await runAgent({
      cfg: cfg(),
      ollama: chatClient(),
      tools: registry(),
      emit: (() => {}) as Emit,
      prompt: "Summarise the quarter",
      suppressFinal: false,
      maxSteps: 3,
      taskId,
    });

    assert.equal(getRunNodes(taskId).filter((node) => node.type === "sibling").length, 0, "no A/B run, no arms");
    clearRun(taskId);
  });
});

