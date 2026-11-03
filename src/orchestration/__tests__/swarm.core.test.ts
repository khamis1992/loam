/** C11 wiring: corePort over public.ts, config clamps, HTTP routes (S3 routes, S5 Core wiring). */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createOrchestrationCore } from "../core.js";
import { coreSwarmPort, loamSwarmCoreFactory } from "../swarm/corePort.js";
import { clampOrchestration, ORCHESTRATION_DEFAULTS } from "../config.js";
import { spansForTask } from "../tracing/tracer.js";
import { SPAN } from "../tracing/genai.js";
import { OllamaClient } from "../../ollama.js";
import { RealSwarmService } from "../swarm/service.js";
import { NOOP_CORE_FACTORY } from "../swarm/corePort.js";
import { handleRealSwarmRoutes } from "../../server/routes/realswarm.js";
import type { WorkerCheckpoint } from "../../agent/checkpoint.js";
import { testConfig } from "./helpers.js";
import { baseTools, scriptedExecutor, swarmConfig, testHost, tmpDir } from "./swarmHelpers.js";

test("corePort: worker checkpoints round-trip through C2 keyed checkpoints; spans nest under loam.run", () => {
  const core = createOrchestrationCore(testConfig(), new OllamaClient("http://127.0.0.1:11434"), "task_swarm_port", "task_swarm_port");
  const port = coreSwarmPort(core, { progressJudgement: true, selectCompetingPatches: false, taskId: "task_swarm_port" });
  assert.ok(port.progress && port.checkpoints && port.tracing);
  assert.equal(port.selection, undefined, "C3 selection is off by default (OD-14)");
  const cp: WorkerCheckpoint = { prompt: "p", messages: [], trace: [], steps: 2, model: "remote-model", usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
  port.checkpoints!.saveWorker("realswarm/r/w1", cp, 1);
  port.checkpoints!.saveWorker("realswarm/r/w1", { ...cp, steps: 5 }, 2);
  assert.equal(port.checkpoints!.loadLatestWorker("realswarm/r/w1")?.steps, 5);
  assert.equal(port.checkpoints!.loadLatestWorker("realswarm/r/none"), undefined);
  const run = port.tracing!.startSpan(SPAN.swarmRun, { "loam.swarm.run_id": "r" });
  const w = port.tracing!.startSpan(SPAN.swarmWorker, { "loam.swarm.worker_id": "w1" }, run);
  w.end({ "loam.swarm.turns": 3 });
  run.end(undefined, "boom");
  core.runSpan.end();
  const spans = spansForTask("task_swarm_port");
  const byName = (n: string) => spans.find((s) => s.name === n)!;
  assert.equal(byName(SPAN.swarmWorker).parentSpanId, byName(SPAN.swarmRun).spanId);
  assert.equal(byName(SPAN.swarmRun).parentSpanId, byName("loam.run").spanId);
  assert.equal(byName(SPAN.swarmRun).status, "error");
  assert.equal(run.traceId, byName("loam.run").traceId);
});

test("corePort: progress judgement and selection degrade without a cloud model", async () => {
  const cfg = { ...testConfig(), orchestrator: { ...testConfig().orchestrator, plannerModel: "", verifierModel: "" } };
  const core = createOrchestrationCore(cfg, new OllamaClient("http://127.0.0.1:11434"), "t_sw_deg", "t_sw_deg");
  const port = coreSwarmPort(core, { progressJudgement: true, selectCompetingPatches: true });
  assert.equal(await port.progress!.judgeProgress({ workerId: "w1", goal: "g", recentTurns: [], boardExcerpt: "" }), undefined);
  const r = await port.selection!.selectBest({ label: "x", goal: "g", candidates: [{ workerId: "w1", branch: "worker/w1/x", gistLabel: "G1", evidence: "e" }] });
  assert.equal(r.method, "single");
  const binding = loamSwarmCoreFactory(cfg, new OllamaClient("http://127.0.0.1:11434"))({ runId: "r", taskId: "t_sw_fac" });
  assert.ok(binding.port.checkpoints && binding.traceId);
  binding.end();
});

test("config: orchestration.swarm defaults and clamps", () => {
  const d = ORCHESTRATION_DEFAULTS.swarm;
  assert.deepEqual(
    { ...d },
    { enabled: true, maxWorkers: 4, claimTtlSeconds: 3600, deadlineMs: 1_800_000, idleNudgeMs: 600_000, activationStaggerMs: 3000, maxInFlightTurns: 4, selectCompetingPatches: false, progressJudgement: true },
  );
  const c = clampOrchestration({ ...structuredClone(ORCHESTRATION_DEFAULTS), swarm: { ...d, maxWorkers: 99, claimTtlSeconds: 1, deadlineMs: 1e12, idleNudgeMs: 0, activationStaggerMs: -5, maxInFlightTurns: 0 } }).swarm;
  assert.equal(c.maxWorkers, 16);
  assert.equal(c.claimTtlSeconds, 60);
  assert.equal(c.deadlineMs, 14_400_000);
  assert.equal(c.idleNudgeMs, 10_000);
  assert.equal(c.activationStaggerMs, 0);
  assert.equal(c.maxInFlightTurns, 1);
});

async function withServer(svc: RealSwarmService | null, fn: (base: string) => Promise<void>) {
  const server = http.createServer(async (req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    if (!(await handleRealSwarmRoutes(req, res, p, svc))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test("routes: /api/realswarm/runs guards (503, 403, 415, 400, 404) and happy path", async () => {
  await withServer(null, async (base) => {
    const r = await fetch(`${base}/api/realswarm/runs`);
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("cache-control"), "no-store");
  });
  const root = tmpDir();
  const svc = new RealSwarmService({
    cfg: swarmConfig(), ollama: new OllamaClient("http://127.0.0.1:11434"), tools: baseTools(), dataDir: root, host: testHost(root), coreFactory: NOOP_CORE_FACTORY, tickMs: 25,
    executor: scriptedExecutor(async (c) => new Promise((_, rej) => c.opts.signal?.addEventListener("abort", () => rej(new Error("aborted"))))),
    testTiming: { activationStaggerMs: 0 },
  });
  await withServer(svc, async (base) => {
    const post = (body: string, headers: Record<string, string> = { "content-type": "application/json" }) => fetch(`${base}/api/realswarm/runs`, { method: "POST", body, headers });
    assert.equal((await post("{}", { "content-type": "application/json", origin: "https://evil.example" })).status, 403);
    assert.equal((await post("{}", { "content-type": "text/plain" })).status, 415);
    assert.equal((await post("{not json")).status, 400);
    assert.equal((await post("[]")).status, 400);
    assert.equal((await post(JSON.stringify({ goal: "g", model: "qwen3:8b" }))).status, 400, "local model refused over HTTP too");
    assert.equal((await post(JSON.stringify({ goal: "x".repeat(90_000) }))).status, 400, "body limit");
    const created = await post(JSON.stringify({ goal: "build it", maxWorkers: 1 }));
    assert.equal(created.status, 201);
    const { run } = (await created.json()) as { run: { id: string } };
    assert.match(run.id, /^realswarm_[a-f0-9-]{36}$/);
    const list = (await (await fetch(`${base}/api/realswarm/runs`)).json()) as { runs: unknown[] };
    assert.equal(list.runs.length, 1);
    assert.equal((await fetch(`${base}/api/realswarm/runs/${run.id}`)).status, 200);
    const board = (await (await fetch(`${base}/api/realswarm/runs/${run.id}/board`)).json()) as { rendered: string };
    assert.equal(typeof board.rendered, "string");
    assert.equal((await fetch(`${base}/api/realswarm/runs/realswarm_x`)).status, 404);
    assert.equal((await fetch(`${base}/api/realswarm/runs/realswarm_00000000-0000-4000-8000-000000000000`)).status, 404);
    const cancel = await fetch(`${base}/api/realswarm/runs/${run.id}/cancel`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(cancel.status, 200);
    await svc.settled(run.id);
    const resume = await fetch(`${base}/api/realswarm/runs/${run.id}/resume`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(resume.status, 409);
    assert.equal((await fetch(`${base}/api/swarm/runs`)).status, 404, "the existing /api/swarm/runs surface is not handled here");
  });
  await svc.close();
});
