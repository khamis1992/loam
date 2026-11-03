import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { orchestrate, getAuditReport, getAuditStatus } from "../orchestrator.js";
import type { OrchestratorDeps } from "../orchestrator.js";
import type { AgentRunFn } from "../agentIO.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { validateFindings } from "../validateFindings.js";
import { validateLedger } from "../validateLedger.js";

function target(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-target-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const run = (x: string) => eval(x);\n");
  return dir;
}

const HUNT = {
  candidates: [{
    title: "eval of request input", description: "User input reaches eval.", root_cause: "No validation before eval.",
    trace: [
      { kind: "entrypoint", file: "src/a.ts", line: 1, description: "param x" },
      { kind: "sink", file: "src/a.ts", line: 1, description: "eval(x)" },
    ],
    evidence: [{ file: "src/a.ts", line: 1, description: "eval call" }],
    impact: "high", likelihood: "medium", remediation: "Remove eval.",
  }],
  coverage: "covered", checks: [{ description: "Read the file", paths: ["src/a.ts"] }], unresolved: [],
};

function fakeRun(verdict: "confirmed" | "refuted"): AgentRunFn {
  return async (o) => {
    const p = o.prompt;
    let out: unknown;
    if (p.includes("reconnaissance agent")) out = { facts: [{ file: "src/a.ts", line: 1, fact: "eval sink" }], summary: "A tiny eval app." };
    else if (p.includes("vulnerability hunter")) out = HUNT;
    else if (p.includes("independent verifier")) out = { evidence_vector: [{ source: "llm", state: verdict, ref: "src/a.ts:1", note: "checked" }], production_viable: true, reason: "checked by hand" };
    else out = { gaps: [], merge: [] };
    return { text: JSON.stringify(out), steps: 1 };
  };
}

function deps(over: Partial<OrchestratorDeps> = {}, verdict: "confirmed" | "refuted" = "confirmed"): OrchestratorDeps {
  return {
    cfg: { model: "base" } as never, ollama: {} as never, tools: new ToolRegistry(),
    run: fakeRun(verdict), acquire: async () => () => undefined,
    exec: async () => ({ code: 127, stdout: "", stderr: "", timedOut: false, spawnError: "ENOENT" }),
    ...over,
  };
}

test("happy path writes valid ledger, findings and reports", async () => {
  const t = target();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "audit-out-"));
  const r = await orchestrate({ target: t, profile: "quick", output_dir: out }, deps());
  assert.equal(r.run_status, "complete", r.incomplete_reason);
  for (const f of ["coverage-ledger.json", "findings.json", "REPORT.md", "FINDINGS-DETAIL.md", "NEEDS-VALIDATION.md", "findings.sarif", "run-metadata.json", "architecture.md"]) {
    assert.ok(fs.existsSync(path.join(out, f)), f);
  }
  assert.equal(validateLedger(fs.readFileSync(path.join(out, "coverage-ledger.json")), { runDir: out }).ok, true);
  assert.equal(validateFindings(fs.readFileSync(path.join(out, "findings.json")), { runDir: out }).ok, true);
  const findings = JSON.parse(fs.readFileSync(path.join(out, "findings.json"), "utf8")) as { verdict: string }[];
  assert.ok(findings.some((f) => f.verdict === "confirmed"));
  assert.ok(fs.readFileSync(path.join(out, "REPORT.md"), "utf8").includes("## 2. Confirmed findings"));
  assert.equal(getAuditStatus(r.run_id)?.stage, "DONE");
  assert.equal(getAuditReport(r.run_id)?.in_progress, false);
});

test("a refuting verifier produces a rejected record, not a confirmed one", async () => {
  const t = target();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "audit-out-"));
  const r = await orchestrate({ target: t, profile: "quick", output_dir: out }, deps({}, "refuted"));
  assert.equal(r.run_status, "complete", r.incomplete_reason);
  const findings = JSON.parse(fs.readFileSync(path.join(out, "findings.json"), "utf8")) as { verdict: string }[];
  assert.ok(findings.length > 0);
  assert.ok(findings.every((f) => f.verdict === "rejected"));
});

test("budget below the reconnaissance reserve ends incomplete without agents", async () => {
  const t = target();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "audit-out-"));
  let calls = 0;
  const run: AgentRunFn = async (o) => { calls++; return fakeRun("confirmed")(o); };
  const r = await orchestrate({ target: t, profile: "quick", budget: 3, output_dir: out }, deps({ run }));
  assert.equal(r.run_status, "incomplete");
  assert.equal(r.incomplete_reason, "budget_cannot_fund_reconnaissance_and_reserves");
  assert.equal(calls, 0);
  assert.ok(fs.existsSync(path.join(out, "REPORT.md")));
});

test("an aborted signal ends the run as cancelled", async () => {
  const t = target();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "audit-out-"));
  const ac = new AbortController();
  ac.abort();
  const r = await orchestrate({ target: t, profile: "quick", output_dir: out }, deps({ signal: ac.signal }));
  assert.equal(r.run_status, "incomplete");
  assert.equal(r.incomplete_reason, "cancelled");
});

test("persisted files never carry a secret value", async () => {
  const t = target();
  fs.writeFileSync(path.join(t, "src", "k.ts"), "const k = 1;\n");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "audit-out-"));
  const secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij";
  const run: AgentRunFn = async (o) => {
    const res = await fakeRun("confirmed")(o);
    return { ...res, text: res.text.replace("Read the file", `Read the file ${secret}`) };
  };
  await orchestrate({ target: t, profile: "quick", output_dir: out }, deps({ run }));
  for (const f of fs.readdirSync(out)) {
    const p = path.join(out, f);
    if (fs.statSync(p).isFile() && !f.endsWith(".sqlite")) assert.ok(!fs.readFileSync(p, "utf8").includes(secret), f);
  }
});
