import { strict as assert } from "node:assert";
import path from "node:path";
import { test } from "node:test";
import { garakPlan, parseGarakReport } from "../lleval/garak.js";

test("garakPlan builds a bounded self-audit command line", () => {
  const p = garakPlan({ modelType: "openai", modelName: "gpt-test", probes: ["dan", "encoding"], outDir: "runs/selfaudit", parallel: 4 });
  assert.deepEqual(p.argv, [
    "--model_type", "openai", "--model_name", "gpt-test", "--probes", "dan,encoding",
    "--report_prefix", path.join("runs", "selfaudit", "garak"), "--narrow_output", "--parallel_requests", "4",
  ]);
  assert.deepEqual(p.okCodes, [0]);
  const minimal = garakPlan({ modelType: "rest", outDir: "o" });
  assert.ok(minimal.argv.includes("--model_type"));
  assert.ok(!minimal.argv.includes("--probes"));
});

test("parseGarakReport counts attempts, hits at >=0.5 and aggregates per probe", () => {
  const jsonl = [
    JSON.stringify({ entry_type: "config", model_type: "openai" }),
    JSON.stringify({ entry_type: "attempt", probe_classname: "probe.Dan", goal: "jailbreak", detector_results: { "detect.DetectorA": [1.0, 0.0], "detect.DetectorB": [0.2] } }),
    JSON.stringify({ entry_type: "attempt", probe_classname: "probe.Dan", goal: "jailbreak", detector_results: { "detect.DetectorA": [0.9] } }),
    JSON.stringify({ entry_type: "attempt", probe_classname: "probe.LeakReplay", goal: "replay", detector_results: { "detect.DetectorC": [0.0] } }),
    "not json",
    "",
  ].join("\n");
  const r = parseGarakReport(jsonl);
  assert.equal(r.attempts, 3);
  assert.equal(r.hits.length, 2);
  assert.ok(r.hits.every((h) => h.probe === "probe.Dan" && h.score >= 0.5));
  assert.deepEqual(r.byProbe, [
    { probe: "probe.Dan", attempts: 2, hits: 2, hitRate: 1 },
    { probe: "probe.LeakReplay", attempts: 1, hits: 0, hitRate: 0 },
  ]);
});

test("parseGarakReport tolerates missing detector results", () => {
  const r = parseGarakReport(JSON.stringify({ entry_type: "attempt", probe_classname: "p" }));
  assert.equal(r.attempts, 1);
  assert.deepEqual(r.hits, []);
});
