/**
 * D18 session insights: the metrics and the issue timeline are exact and
 * model-free; the model is only used to enrich the feedback and the improved
 * prompt (mocked here). The route is exercised over a real recorded log.
 */
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { after, before, describe, it } from "node:test";
import { computeInsights, estimateCostUsd, generateInsights, parseInsightReply, type InsightsInput, type TimedAgentEvent } from "../insights.js";
import type { AgentEvent } from "../events.js";

const BASE = Date.parse("2026-01-01T00:00:00.000Z");
const at = (seconds: number) => new Date(BASE + seconds * 1000).toISOString();

function fixtureEvents(): TimedAgentEvent[] {
  return [
    { at: at(0), event: { type: "step", index: 0 } as AgentEvent },
    { at: at(1), event: { type: "tool_call", name: "shell_run", args: { command: "npm test" } } as AgentEvent },
    { at: at(2), event: { type: "tool_result", name: "shell_run", ok: false, summary: "command not found: npm" } as AgentEvent },
    { at: at(3), event: { type: "error", message: "build failed" } as AgentEvent },
    { at: at(4), event: { type: "revise", id: "s1", attempt: 1, fixes: ["install deps"] } as AgentEvent },
    // 116s after the revise: an idle gap that counts as a stall.
    { at: at(120), event: { type: "tool_call", name: "file_write", args: { path: "index.html" } } as AgentEvent },
    { at: at(121), event: { type: "tool_result", name: "file_write", ok: true, summary: "wrote index.html" } as AgentEvent },
    { at: at(122), event: { type: "done", text: "done", steps: 4, model: "gpt-4o" } as AgentEvent },
  ];
}

function fixtureInput(overrides: Partial<InsightsInput> = {}): InsightsInput {
  return {
    taskId: "task_fixture",
    prompt: "Build a counter app",
    status: "done",
    model: "gpt-4o",
    startedAt: at(0),
    endedAt: at(122),
    events: fixtureEvents(),
    messages: [
      { role: "user", content: "Build a counter app" },
      { role: "assistant", content: "done" },
    ],
    usage: { promptTokens: 1000, completionTokens: 500 },
    ...overrides,
  };
}

describe("session insights (D18)", () => {
  it("computes metrics exactly from the recorded log", () => {
    const insights = computeInsights(fixtureInput());
    assert.deepEqual(insights.metrics, {
      steps: 4,
      toolCalls: 2,
      toolFailures: 1,
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      costUsd: 0.0075,
      userMessages: 1,
      assistantMessages: 1,
      durationMs: 122_000,
      category: "build",
      model: "gpt-4o",
    });
  });

  it("lists the fixture issues in the order they were recorded", () => {
    const timeline = computeInsights(fixtureInput()).issueTimeline;
    assert.deepEqual(
      timeline.map((i) => i.kind),
      ["failure", "error", "retry", "stall"],
    );
    assert.equal(timeline[0]!.detail, "shell_run: command not found: npm");
    assert.equal(timeline[1]!.detail, "build failed");
    assert.equal(timeline[2]!.tool, "s1");
    assert.match(timeline[3]!.detail, /^idle 1m 5[0-9]s before tool_call$/);
  });

  it("counts memory and skill tool usage separately", () => {
    const input = fixtureInput({
      events: [
        { at: at(0), event: { type: "tool_call", name: "memory_search", args: {} } as AgentEvent },
        { at: at(1), event: { type: "tool_call", name: "skill_view", args: { name: "pdf" } } as AgentEvent },
        { at: at(2), event: { type: "tool_call", name: "file_read", args: { path: "a" } } as AgentEvent },
      ],
      memories: 3,
      skills: 2,
    });
    const { knowledgeUsage } = computeInsights(input);
    assert.deepEqual(knowledgeUsage, { memories: 3, skills: 2, memoryToolCalls: 1, skillToolCalls: 1 });
  });

  it("estimates cost for priced models and 0 for local ones", () => {
    assert.equal(estimateCostUsd("gpt-4o", 1_000_000, 1_000_000), 12.5);
    assert.equal(estimateCostUsd("gpt-4o:cloud", 1000, 500), 0.0075);
    assert.equal(estimateCostUsd("llama3.2", 1000, 500), 0);
  });

  it("builds a deterministic improved prompt from the observed issues", () => {
    const { improvedPrompt, actionableFeedback } = computeInsights(fixtureInput());
    assert.ok(improvedPrompt?.includes("Build a counter app"));
    assert.ok(improvedPrompt?.includes("shell_run"));
    assert.ok(actionableFeedback.length > 0);
  });

  it("uses a mocked model to enrich feedback and the improved prompt", async () => {
    const mock = {
      chat: async () => ({ content: JSON.stringify({ feedback: ["mock feedback"], improvedPrompt: "mock improved prompt" }) }),
    };
    const insights = await generateInsights(fixtureInput(), { ollama: mock, model: "mock-model" });
    assert.deepEqual(insights.actionableFeedback, ["mock feedback"]);
    assert.equal(insights.improvedPrompt, "mock improved prompt");
    // Metrics stay exact regardless of the model reply.
    assert.equal(insights.metrics.totalTokens, 1500);
  });

  it("falls back to the deterministic result when the model fails or replies garbage", async () => {
    const throwing = { chat: async () => { throw new Error("offline"); } };
    const fallback = await generateInsights(fixtureInput(), { ollama: throwing });
    assert.equal(fallback.actionableFeedback.length > 0, true);
    assert.ok(fallback.improvedPrompt?.includes("Build a counter app"));

    const garbage = { chat: async () => ({ content: "not json at all" }) };
    assert.equal(parseInsightReply("not json at all"), null);
    assert.deepEqual(parseInsightReply('```json\n{"feedback":["a"]}\n```'), { feedback: ["a"] });
  });
});

describe("GET /api/tasks/:id/insights route (D18)", () => {
  let tmpDir = "";
  let closeDb: () => void;
  let db: typeof import("../../server/db.js");
  let appendTelemetry: typeof import("../../telemetry/store.js").appendTelemetry;
  let handleInsightsRoutes: typeof import("../../server/routes/insights.js").handleInsightsRoutes;

  function fakeRes(): http.ServerResponse & { body(): string; statusCode: number } {
    const chunks: Buffer[] = [];
    const res = {
      statusCode: 0,
      writeHead(code: number) { res.statusCode = code; return res; },
      end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); return res; },
      body: () => Buffer.concat(chunks).toString("utf8"),
    };
    return res as unknown as http.ServerResponse & { body(): string; statusCode: number };
  }

  function fakeReq(method: string): http.IncomingMessage {
    return { method } as unknown as http.IncomingMessage;
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-insights-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../../server/sqliteStore.js");
    closeDb = sqlite.closeDb;
    db = await import("../../server/db.js");
    const telemetry = await import("../../telemetry/store.js");
    appendTelemetry = telemetry.appendTelemetry;
    ({ handleInsightsRoutes } = await import("../../server/routes/insights.js"));
    db.loadDb();
  });

  after(() => {
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { closeDb(); } catch { /* already closed */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns JSON with exact metrics and the ordered timeline", async () => {
    const task = db.createTask("Build a counter app", "Counter");
    task.model = "gpt-4o";
    for (const e of fixtureEvents()) db.appendStep(task.id, { at: e.at, type: e.event.type, data: e.event });
    appendTelemetry({
      at: new Date().toISOString(),
      kind: "task",
      taskId: task.id,
      model: "gpt-4o",
      status: "done",
      steps: 4,
      durationMs: 122_000,
      usage: { promptTokens: 1000, completionTokens: 500 },
      toolCalls: [],
      promptHash: "x",
      promptChars: 16,
    });

    const res = fakeRes();
    const handled = await handleInsightsRoutes(fakeReq("GET"), res, `/api/tasks/${task.id}/insights`);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body()) as {
      insights: { metrics: Record<string, unknown>; issueTimeline: Array<{ kind: string }>; actionableFeedback: string[] };
    };
    assert.equal(body.insights.metrics.totalTokens, 1500);
    assert.equal(body.insights.metrics.costUsd, 0.0075);
    assert.deepEqual(body.insights.issueTimeline.map((i) => i.kind), ["failure", "error", "retry", "stall"]);
    assert.ok(body.insights.actionableFeedback.length > 0);
  });

  it("404s unknown tasks and 405s non-GET", async () => {
    const missing = fakeRes();
    await handleInsightsRoutes(fakeReq("GET"), missing, "/api/tasks/task_missing/insights");
    assert.equal(missing.statusCode, 404);

    const task = db.createTask("x", "X");
    const wrongMethod = fakeRes();
    await handleInsightsRoutes(fakeReq("POST"), wrongMethod, `/api/tasks/${task.id}/insights`);
    assert.equal(wrongMethod.statusCode, 405);
  });
});
