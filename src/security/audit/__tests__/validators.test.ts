import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tryDeriveCoverageId } from "../coverageId.js";
import { discardAgentAssurance, validateFindings } from "../validateFindings.js";
import { validateLedger } from "../validateLedger.js";

function run(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "audit-val-")));
}

function unit(over: Record<string, unknown> = {}): Record<string, unknown> {
  const refs = { surface: "http", boundary: "user-input", subsystem: "api", attack_class: "injection" };
  const d = tryDeriveCoverageId(refs as never);
  assert.ok(d.ok);
  return {
    coverage_id: d.ok ? d.id : "", canonical_refs: refs, ...refs, starting_paths: ["src/a.ts"],
    ordinary_attack_class_block: null, selected_companion_blocks: [], excluded_blocks: [],
    prior_status: "new", attempts: [], wave: 1, status: "planned", agent_id: null,
    reviewed_paths: [], local_checks: [], result_fingerprints: [], unresolved: [], ...over,
  };
}

const sourceCheck = (over: Record<string, unknown> = {}) => ({
  agent_id: "h1", reviewed_paths: ["src/a.ts"], invariant: "inv", method: "source", result: "ok",
  artifact: null, assurance: null, ...over,
});

const buf = (v: unknown): Buffer => Buffer.from(JSON.stringify(v));

test("planned unit with no results is valid", () => {
  const r = validateLedger(buf([unit()]), { runDir: run() });
  assert.deepEqual(r.errors, []);
  assert.ok(r.ok);
});

test("covered unit needs paths/checks and empty unresolved", () => {
  const bad = unit({ status: "covered", agent_id: "h1", unresolved: ["x"] });
  const r = validateLedger(buf([bad]), { runDir: run() });
  assert.ok(!r.ok);
  const good = unit({
    status: "covered", agent_id: "h1", reviewed_paths: ["src/a.ts"], local_checks: [sourceCheck()],
  });
  assert.ok(validateLedger(buf([good]), { runDir: run() }).ok);
});

test("T13a local check without assurance is an error", () => {
  const u = unit({
    status: "covered", agent_id: "h1", reviewed_paths: ["src/a.ts"],
    local_checks: [sourceCheck({ method: "local", artifact: "agents/h1/artifacts/p.txt", assurance: null })],
  });
  const r = validateLedger(buf([u]), { runDir: run() });
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.includes("requires assurance")));
});

test("T13b source check with non-null assurance is an error", () => {
  const u = unit({
    status: "covered", agent_id: "h1", reviewed_paths: ["src/a.ts"],
    local_checks: [sourceCheck({ assurance: "full" })],
  });
  const r = validateLedger(buf([u]), { runDir: run() });
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.includes("assurance null")));
});

test("T13c local check assurance must equal its promotion record", () => {
  const dir = run();
  fs.mkdirSync(path.join(dir, "agents", "h1", "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "h1", "artifacts", "p.txt"), "poc");
  const rel = "agents/h1/artifacts/p.txt";
  fs.writeFileSync(
    path.join(dir, "agents", "h1", "promotions.json"),
    JSON.stringify([{ agent_id: "h1", scratch_rel: "p.txt", artifact_rel: rel, bytes: 3, sha256: "0".repeat(64), assurance: "reduced-win32" }]),
  );
  const mk = (assurance: string) =>
    unit({
      status: "covered", agent_id: "h1", reviewed_paths: ["src/a.ts"],
      local_checks: [sourceCheck({ method: "local", artifact: rel, assurance })],
    });
  assert.ok(validateLedger(buf([mk("reduced-win32")]), { runDir: dir }).ok);
  const bad = validateLedger(buf([mk("full")]), { runDir: dir });
  assert.ok(!bad.ok);
  assert.ok(bad.errors.some((e) => e.includes("differs from promotion record")));
});

test("ledger rejects bad coverage_id, unsorted and duplicate units, extra fields", () => {
  const a = unit();
  assert.ok(!validateLedger(buf([{ ...a, coverage_id: "wrong" }]), { runDir: run() }).ok);
  assert.ok(!validateLedger(buf([a, a]), { runDir: run() }).ok);
  assert.ok(!validateLedger(buf([{ ...a, bogus: 1 }]), { runDir: run() }).ok);
  assert.ok(validateLedger(buf([{ ...a, x_note: 1 }]), { runDir: run() }).ok);
  assert.ok(!validateLedger(buf({}), { runDir: run() }).ok);
});

const trace = (kind: string) => ({ kind, file: "src/a.ts", line: 1, scope: "f", description: "d" });
function needsValidation(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdict: "needs_validation", fingerprint: "fp-1", title: "t", description: "d", claimed_root_cause: "c",
    trace: [trace("entrypoint"), trace("sink")], evidence: [{ file: "src/a.ts", line: 1, description: "d" }],
    blockers: ["no docker"], validation_plan: { local: "run it" },
    evidence_vector: [{ source: "llm", state: "unknown", ref: "r" }], evidence_assurance: "source-only", ...over,
  };
}

test("findings: valid needs_validation without a ledger is source-only", () => {
  const r = validateFindings(buf([needsValidation()]), { runDir: run() });
  assert.deepEqual(r.errors, []);
});

test("T14a missing evidence_assurance is an error", () => {
  const f = needsValidation();
  delete f.evidence_assurance;
  assert.ok(!validateFindings(buf([f]), { runDir: run() }).ok);
});

test("T14b evidence_assurance must equal the weakest linked check", () => {
  const dir = run();
  fs.mkdirSync(path.join(dir, "agents", "h1", "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "h1", "artifacts", "p.txt"), "poc");
  const rel = "agents/h1/artifacts/p.txt";
  fs.writeFileSync(
    path.join(dir, "agents", "h1", "promotions.json"),
    JSON.stringify([{ agent_id: "h1", scratch_rel: "p.txt", artifact_rel: rel, bytes: 3, sha256: "0".repeat(64), assurance: "reduced-win32" }]),
  );
  const u = unit({
    status: "candidate", agent_id: "h1", reviewed_paths: ["src/a.ts"], result_fingerprints: ["fp-1"],
    local_checks: [sourceCheck({ method: "local", artifact: rel, assurance: "reduced-win32" })],
  });
  fs.writeFileSync(path.join(dir, "coverage-ledger.json"), JSON.stringify([u]));
  const ok = validateFindings(buf([needsValidation({ evidence_assurance: "reduced-win32" })]), { runDir: dir });
  assert.deepEqual(ok.errors, []);
  const bad = validateFindings(buf([needsValidation({ evidence_assurance: "full" })]), { runDir: dir });
  assert.ok(!bad.ok);
  assert.ok(bad.errors.some((e) => e.includes("weakest linked check")));
});

test("T14c agent-supplied evidence_assurance is discarded", () => {
  const out = discardAgentAssurance([{ a: 1, evidence_assurance: "full", n: { evidence_assurance: "full", b: 2 } }]);
  assert.deepEqual(out, [{ a: 1, n: { b: 2 } }]);
});

test("findings semantic checks: trace order, sorting, duplicates, paths, validation plan", () => {
  const d = { runDir: run() };
  assert.ok(!validateFindings(buf([needsValidation({ trace: [trace("sink"), trace("entrypoint")] })]), d).ok);
  assert.ok(!validateFindings(buf([needsValidation({ trace: [trace("propagation")] })]), d).ok);
  assert.ok(!validateFindings(buf([needsValidation(), needsValidation()]), d).ok);
  assert.ok(!validateFindings(buf([needsValidation({ fingerprint: "b" }), needsValidation({ fingerprint: "a" })]), d).ok);
  assert.ok(!validateFindings(buf([needsValidation({ evidence: [{ file: "/etc/passwd", line: 1, description: "d" }] })]), d).ok);
  assert.ok(!validateFindings(buf([needsValidation({ validation_plan: {} })]), d).ok);
  assert.ok(!validateFindings(Buffer.from("not json"), d).ok);
});
