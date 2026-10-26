import { test } from "node:test";
import assert from "node:assert/strict";
import { directReturnText, stripDelegateHeader } from "../handoff/returnDirect.js";
import { compositeScore, rerank } from "../memory/rank.js";
import { scoreTrajectory, judgeTrajectory } from "../evals/trajectory.js";
import { isCloudModel, pickCloudModel, NoCloudModelError } from "../../llm/cloudModel.js";
import { clampOrchestration, ORCHESTRATION_DEFAULTS } from "../config.js";
import { scriptedPort, testConfig } from "./helpers.js";

// The helper's remote provider is openai-compatible keyed by X_KEY; router
// usability requires the key to exist before the provider can serve its model.
process.env.X_KEY = "test-key";

test("C10: only a single successful delegate call with return_direct ends the turn", () => {
  const content = '[Subagent "researcher" finished in 4 step(s), 9 tool call(s)]\n\nFinal report body';
  assert.equal(stripDelegateHeader(content), "Final report body");
  assert.equal(directReturnText([{ tool: "delegate_task", ok: true, content, returnDirect: true }], true), "Final report body");
  assert.equal(directReturnText([{ tool: "delegate_task", ok: true, content, returnDirect: true }], false), undefined);
  assert.equal(directReturnText([{ tool: "delegate_task", ok: false, content, returnDirect: true }], true), undefined);
  assert.equal(directReturnText([{ tool: "web_fetch", ok: true, content, returnDirect: true }], true), undefined);
  assert.equal(
    directReturnText([{ tool: "delegate_task", ok: true, content, returnDirect: true }, { tool: "delegate_task", ok: true, content, returnDirect: true }], true),
    undefined,
  );
});

test("C9: composite score uses CrewAI weights and half-life", () => {
  const w = { similarityWeight: 0.5, recencyWeight: 0.3, importanceWeight: 0.2, recencyHalfLifeDays: 30 };
  const now = Date.parse("2026-10-25T00:00:00Z");
  const fresh = { score: 0.8, entry: { createdAt: "2026-10-25T00:00:00Z", kind: "fact", importance: 0.5 } };
  const old = { score: 0.8, entry: { createdAt: "2026-09-25T00:00:00Z", kind: "fact", importance: 0.5 } };
  assert.equal(compositeScore(fresh, w, now).score, 0.8);
  assert.equal(compositeScore(old, w, now).score, 0.65);
  const pref = { score: 0.7, entry: { createdAt: "2026-10-24T00:00:00Z", kind: "preference" } };
  const ranked = rerank([old, fresh, pref], 2, w, now);
  assert.deepEqual(ranked.map((r) => r.composite), [0.8, 0.7831]);
});

test("C8: deterministic trajectory score covers recall, order, precision, efficiency, forbidden", () => {
  const ex = { steps: [{ tool: "web_search" }, { tool: "web_fetch", args: { url: "nutrio" } }, { tool: "write_file" }], ordering: "relaxed" as const, forbiddenTools: ["shell"], maxSteps: 4 };
  const perfect = scoreTrajectory([{ name: "web_search", ok: true }, { name: "web_fetch", ok: true, args: { url: "https://nutrio.qa" } }, { name: "write_file", ok: true }], ex);
  assert.equal(perfect.score, 1);
  const messy = scoreTrajectory(
    [{ name: "write_file", ok: true }, { name: "web_search", ok: true }, { name: "web_search", ok: true }, { name: "web_fetch", ok: true, args: { url: "x" } }, { name: "read_file", ok: true }],
    ex,
  );
  assert.deepEqual(messy.missing, ["web_fetch"]);
  assert.ok(messy.score < 0.7);
  const bad = scoreTrajectory([{ name: "shell", ok: true }, ...[{ name: "web_search", ok: true }, { name: "web_fetch", ok: true, args: { url: "nutrio" } }, { name: "write_file", ok: true }]], ex);
  assert.equal(bad.score, 0.2);
  assert.deepEqual(bad.forbidden, ["shell"]);
  const strict = scoreTrajectory([{ name: "web_search", ok: true }, { name: "read_file", ok: true }, { name: "web_fetch", ok: true, args: { url: "nutrio" } }, { name: "write_file", ok: true }], { ...ex, ordering: "strict" });
  assert.equal(strict.order, 0.333, "strict: required steps must run back-to-back");
});

test("C8: judge trajectory uses the contract and computes ratios", async () => {
  const port = scriptedPort([JSON.stringify({ steps: [{ index: 0, necessary: true, inOrder: true }, { index: 1, necessary: false, inOrder: true }], overall: "one wasted call" })]);
  const j = await judgeTrajectory(port, "m:cloud", "goal", [{ name: "a", ok: true }, { name: "b", ok: true }]);
  assert.equal(j?.necessaryRatio, 0.5);
  assert.equal(j?.score, 0.7);
});

test("cloud-only rule: local and LAN models never qualify", () => {
  const cfg = testConfig();
  assert.equal(isCloudModel(cfg, "gpt-oss:120b:cloud"), true);
  assert.equal(isCloudModel(cfg, "qwen3:8b"), false);
  assert.equal(isCloudModel(cfg, "lan-model"), false);
  assert.equal(isCloudModel(cfg, "remote-model"), true);
  assert.equal(isCloudModel(cfg, "unknown"), false);
  assert.equal(pickCloudModel(cfg, "x", ["", "qwen3:8b", "remote-model"]), "remote-model");
  assert.throws(() => pickCloudModel(cfg, "ledger", ["qwen3:8b"]), NoCloudModelError);
});

test("config clamp bounds hand-edited values", () => {
  const c = clampOrchestration({ ...ORCHESTRATION_DEFAULTS, ledger: { ...ORCHESTRATION_DEFAULTS.ledger, maxStallCount: 999, everyTurns: 0 }, tracing: { ...ORCHESTRATION_DEFAULTS.tracing, sampleRate: 7 } });
  assert.equal(c.ledger.maxStallCount, 10);
  assert.equal(c.ledger.everyTurns, 1);
  assert.equal(c.tracing.sampleRate, 1);
});
