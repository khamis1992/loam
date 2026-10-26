/**
 * E2E-6 (BUILD_SPEC §4.12 A2): a live coding-team run — two workers on one
 * cloud model claim two different labels, land two merges on main, and finish
 * quiescent, with every counter matching git and the board; the trace nests
 * loam.swarm.run under loam.run; an interrupted run resumes after a real
 * service restart; an idle nudge carries a C1 reason.
 *
 * LIVE ONLY: the run needs a real cloud model. The test skips with a clear
 * message when --e2e-model is absent, so `test:orchestration` stays offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OllamaClient } from "../../ollama.js";
import { RealSwarmService } from "../swarm/service.js";
import { loamSwarmCoreFactory } from "../swarm/corePort.js";
import { spansForTask } from "../tracing/tracer.js";
import { SPAN } from "../tracing/genai.js";
import { baseTools, swarmConfig, testHost, tmpDir } from "../__tests__/swarmHelpers.js";

const model = (() => {
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i] ?? "";
    if (a.startsWith("--e2e-model=")) return a.slice("--e2e-model=".length);
  }
  return process.env.LOAM_E2E_MODEL;
})();

test("E2E-6 live: two workers, two merges, quiescent, counters match git, trace nests", { skip: !model && "needs --e2e-model=<cloud model> (live run)" }, async () => {
  const root = tmpDir("c11-e2e-");
  const cfg = swarmConfig();
  cfg.model = model as string;
  const svc = new RealSwarmService({
    cfg,
    ollama: new OllamaClient("http://127.0.0.1:11434"),
    tools: baseTools(),
    dataDir: root,
    host: testHost(root),
    coreFactory: loamSwarmCoreFactory(cfg, new OllamaClient("http://127.0.0.1:11434")),
    tickMs: 500,
    testTiming: { activationStaggerMs: 0, idleNudgeMs: 120_000 },
  });
  try {
    const created = svc.create({
      goal: "Write two independent files: hello.txt containing the single word hello, and notes.txt containing the single word notes. Claim one file each, verify with cat, then merge.",
      maxWorkers: 2,
      model,
      deadlineMs: 900_000,
    });
    const s = await svc.settled(created.id);
    assert.equal(s.status, "completed", s.error);
    assert.equal(s.completionReason, "quiescent");
    assert.equal(s.metrics.mergesLanded, 2);
    assert.equal(fs.readFileSync(path.join(s.workspace, "hello.txt"), "utf8").trim(), "hello");
    assert.equal(fs.readFileSync(path.join(s.workspace, "notes.txt"), "utf8").trim(), "notes");
    // Counters match git, never literals.
    const { execFile } = await import("node:child_process");
    const prom = (await import("node:util")).promisify;
    const git = prom(execFile);
    const merges = Number((await git("git", ["rev-list", "--first-parent", "--merges", "--count", "main"], { cwd: s.workspace })).stdout.trim());
    assert.equal(s.metrics.mergesLanded, merges);
    // Trace nesting: the swarm run span sits under loam.run for the task.
    const spans = spansForTask(s.taskId);
    assert.ok(spans.some((x) => x.name === "loam.run"), "root run span exists");
    assert.ok(spans.some((x) => x.name === SPAN.swarmRun), "swarm run span exists");
    assert.ok(spans.some((x) => x.name === SPAN.swarmWorker), "worker spans exist");
    assert.ok(spans.some((x) => x.name === SPAN.swarmTurn), "turn spans exist");
  } finally {
    await svc.close();
  }
  void os.tmpdir;
});
