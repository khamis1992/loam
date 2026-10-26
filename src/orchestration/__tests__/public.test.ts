import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrchestrationCore } from "../core.js";
import { saveKeyedCheckpoint, loadLatestKeyedCheckpoint, recordCheckpoint, judgeProgress, selectWithCore } from "../public.js";
import { OllamaClient } from "../../ollama.js";
import { testConfig } from "./helpers.js";
import { spansForTask } from "../tracing/tracer.js";

test("core facade: cloud-only model choice, traceparent env, keyed checkpoints", async () => {
  const cfg = testConfig();
  const core = createOrchestrationCore(cfg, new OllamaClient("http://127.0.0.1:11434"), "task_core", "task_core");
  assert.equal(core.modelFor("ledger"), "gpt-oss:120b:cloud", "falls through to orchestrator.plannerModel");
  const local = createOrchestrationCore({ ...cfg, orchestrator: { ...cfg.orchestrator, plannerModel: "" } }, new OllamaClient("http://127.0.0.1:11434"), "t2", "t2");
  assert.equal(local.modelFor("ledger"), undefined, "cfg.model is local: no model, feature degrades");
  assert.match(core.traceparentEnv().TRACEPARENT ?? "", /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.equal(recordCheckpoint(core, "t", "t", { round: 0, nextStep: 0, completed: [] }, 0), undefined, "failed append is skipped");
  saveKeyedCheckpoint(core, "realswarm/r1/w1", { steps: 3, round: 0 }, 1);
  saveKeyedCheckpoint(core, "realswarm/r1/w1", { steps: 7, round: 0 }, 2);
  assert.deepEqual(loadLatestKeyedCheckpoint(core, "realswarm/r1/w1"), { steps: 7, round: 0 });
  core.runSpan.end();
  assert.equal(spansForTask("task_core")[0]?.name, "loam.run");
});

test("judgeProgress and selectWithCore degrade without a cloud model", async () => {
  const cfg = { ...testConfig(), orchestrator: { ...testConfig().orchestrator, plannerModel: "", verifierModel: "" } };
  const core = createOrchestrationCore(cfg, new OllamaClient("http://127.0.0.1:11434"), "t3", "t3");
  assert.equal(await judgeProgress(core, { goal: "g", recentDigest: "d" }), undefined);
  const r = await selectWithCore(core, "g", [{ id: "a", ok: true, text: "x" }, { id: "b", ok: true, text: "x" }]);
  assert.equal(r.method, "single");
});
