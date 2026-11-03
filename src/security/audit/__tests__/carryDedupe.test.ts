import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BudgetMeter, createLimiter, runAgentJson } from "../agentIO.js";
import type { AgentDeps, AgentRunFn, ModelCallResult } from "../agentIO.js";
import { findPriorRun, knownFindingsFor, priorStatusFor, SOURCE_HASHES_FILE } from "../carry.js";
import { dedupeDeterministic, judgeDuplicates } from "../dedupe.js";
import type { Candidate } from "../fpFilter.js";
import { ToolRegistry } from "../../../tools/registry.js";
import type { SchemaObject } from "../schema.js";

const SCHEMA: SchemaObject = { type: "object", required: ["ok"], properties: { ok: { type: "string" } } };

function deps(run: AgentRunFn, over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    cfg: { model: "base" } as never, ollama: {} as never, tools: new ToolRegistry(),
    budget: new BudgetMeter(50), run, acquire: async () => () => undefined, ...over,
  };
}

test("limiter never runs more than the cap at once", async () => {
  const lim = createLimiter(2);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 8 }, () => lim(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
  })));
  assert.equal(peak, 2);
});

test("outcomes are typed: ok and failed(reason)", async () => {
  const seen: ModelCallResult[] = [];
  const good = deps(async () => ({ text: '{"ok":"y"}', steps: 1 }), { onOutcome: (e) => seen.push(e) });
  const bad = deps(async () => ({ text: "prose", steps: 1 }), { onOutcome: (e) => seen.push(e) });
  await runAgentJson(good, { role: "audit-research", prompt: "p", schema: SCHEMA });
  await runAgentJson(bad, { role: "audit-hunter", prompt: "p", schema: SCHEMA });
  assert.deepEqual(seen[0], { role: "audit-research", ok: true });
  assert.equal(seen[1]?.ok, false);
});

test("rate limits back off and retry, other errors do not", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const d = deps(async () => {
    calls++;
    if (calls < 3) throw new Error("429 Too Many Requests");
    return { text: '{"ok":"y"}', steps: 1 };
  }, { sleep: async (ms) => { sleeps.push(ms); } });
  const r = await runAgentJson(d, { role: "audit-research", prompt: "p", schema: SCHEMA });
  assert.equal(r.ok, true);
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1]! > sleeps[0]!);

  let other = 0;
  const e = deps(async () => { other++; throw new Error("boom"); }, { sleep: async () => undefined });
  assert.equal((await runAgentJson(e, { role: "audit-research", prompt: "p", schema: SCHEMA })).ok, false);
  assert.equal(other, 1);
});

function mkRun(files: Record<string, unknown>): { root: string; dir: string; prev: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "carry-"));
  const prev = path.join(root, "run-1");
  const dir = path.join(root, "run-2");
  fs.mkdirSync(prev); fs.mkdirSync(dir);
  for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(prev, k), JSON.stringify(v));
  return { root, dir, prev };
}

const unit = (id: string, status: string, fps: string[] = [], paths = ["a.ts"]) => ({
  coverage_id: id, starting_paths: paths, status, result_fingerprints: fps,
});
const finding = (fp: string, verdict: string, file = "a.ts") => ({
  fingerprint: fp, verdict, title: `title ${fp}`, trace: [{ file }], evidence: [],
});

test("carry: missing ledger yields no prior; states follow source hashes", () => {
  const none = mkRun({});
  assert.equal(findPriorRun(none.dir), null);

  const r = mkRun({
    "coverage-ledger.json": [unit("u1", "candidate", ["f1"]), unit("u2", "covered"), unit("u3", "candidate", ["f2"])],
    "findings.json": [finding("f1", "confirmed"), finding("f2", "rejected")],
    [SOURCE_HASHES_FILE]: { "a.ts": "h1" },
  });
  const prior = findPriorRun(r.dir);
  assert.ok(prior);
  const same = { "a.ts": "h1" };
  const changed = { "a.ts": "h2" };
  const u = (id: string) => ({ coverage_id: id, starting_paths: ["a.ts"] });
  assert.equal(priorStatusFor(u("u1"), prior, same), "prior_confirmed_same_source");
  assert.equal(priorStatusFor(u("u1"), prior, changed), "prior_confirmed_changed_source");
  assert.equal(priorStatusFor(u("u2"), prior, same), "prior_covered_same_source");
  assert.equal(priorStatusFor(u("u3"), prior, changed), "prior_rejected_claim_changed");
  assert.equal(priorStatusFor(u("nope"), prior, same), "new");
  assert.equal(priorStatusFor(u("u1"), null, same), "new");

  // Rejected claims are shown to the hunter only while the source is unchanged.
  assert.deepEqual(knownFindingsFor(u("u3"), prior, same).map((k) => k.fingerprint), ["f1", "f2"]);
  assert.deepEqual(knownFindingsFor(u("u3"), prior, changed).map((k) => k.fingerprint), ["f1"]);
});

test("carry: an output_dir run has no sibling history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "carry-"));
  assert.equal(findPriorRun(path.join(root, "x--run-0")), null);
});

const cand = (fp: string, title: string, over: Record<string, unknown> = {}): Candidate => ({
  verdict: "needs_validation", fingerprint: fp, title, description: "d", claimed_root_cause: "r",
  trace: [], evidence: [], blockers: [], validation_plan: {}, evidence_vector: [],
  evidence_assurance: "source-only", primary_file: "a.ts", ...over,
}) as unknown as Candidate;

test("deterministic dedupe folds same file and title, keeps the stronger, records the loser", () => {
  const a = cand("fa", "SQL injection in query");
  const b = cand("fb", "sql  injection in QUERY!", { verdict: "confirmed", root_cause: "r", confidence: { score: "high", reason: "x" } });
  const c = cand("fc", "Other issue");
  const { kept, map } = dedupeDeterministic([a, b, c]);
  assert.deepEqual(kept.map((x) => x.fingerprint).sort(), ["fb", "fc"]);
  assert.equal(map["fa"]?.superseded_by, "fb");
  assert.equal(map["fa"]?.by, "deterministic");
});

test("judge: confirmed pair is folded and recorded; the critic proposal alone does nothing", async () => {
  const a = cand("fa", "Path traversal in upload");
  const b = cand("fb", "Unsafe file path join");
  const reply = JSON.stringify({ verdicts: [{ a: "fa", b: "fb", duplicate: true, keep: "fa", reason: "same join" }] });
  const d = deps(async () => ({ text: reply, steps: 1 }));
  const r = await judgeDuplicates(d, [a, b], [["fa", "fb"]], {});
  assert.deepEqual(r.kept.map((x) => x.fingerprint), ["fa"]);
  assert.equal(r.map["fb"]?.by, "judge");

  const no = JSON.stringify({ verdicts: [{ a: "fa", b: "fb", duplicate: false, keep: "fa", reason: "different" }] });
  const r2 = await judgeDuplicates(deps(async () => ({ text: no, steps: 1 })), [a, b], [["fa", "fb"]], {});
  assert.equal(r2.kept.length, 2);
});

test("judge: failures fail open and are reported; bogus verdicts are ignored", async () => {
  const a = cand("fa", "One");
  const b = cand("fb", "Two");
  const r = await judgeDuplicates(deps(async () => ({ text: "not json", steps: 1 })), [a, b], [["fa", "fb"]], {});
  assert.equal(r.kept.length, 2);
  assert.equal(r.judgeFailures.length, 1);

  const bogus = JSON.stringify({ verdicts: [{ a: "fa", b: "zz", duplicate: true, keep: "fa", reason: "x" }, { a: "fa", b: "fb", duplicate: true, keep: "other", reason: "x" }] });
  const r2 = await judgeDuplicates(deps(async () => ({ text: bogus, steps: 1 })), [a, b], [], {});
  assert.equal(r2.kept.length, 2);
  assert.deepEqual(r2.map, {});
});
