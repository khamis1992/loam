import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuditTools, readLines } from "../agentTools.js";
import { fastPath, fingerprintOf } from "../fastPath.js";
import { finalizeConfirmed } from "../confirm.js";
import type { Confirmed, ReconHit } from "../types.js";

function hit(over: Partial<ReconHit>): ReconHit {
  return { tool: "gitleaks", ruleId: "aws-key", message: "m", file: "src/a.ts", line: 3, cls: "secret", severity: "high", deterministic: true, raw: {}, ...over };
}

test("readLines is bounded and 1-based", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-rl-"));
  const f = path.join(dir, "a.txt");
  fs.writeFileSync(f, Array.from({ length: 1000 }, (_, i) => `l${i + 1}`).join("\n"));
  const r = readLines(f, 2, 5000);
  assert.equal(r.text.split("\n").length, 400);
  assert.ok(r.text.startsWith("2: l2"));
  assert.equal(r.total, 1000);
});

test("find_references rejects non-identifiers; sandbox refuses", async () => {
  const tools = createAuditTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["audit_sandbox_run", "find_references", "read_definition", "read_source"]);
  const ctx = { workspace: os.tmpdir() } as never;
  const fr = tools.find((t) => t.name === "find_references")!;
  assert.equal((await fr.run({ symbol: "a.*b" }, ctx)).ok, false);
  const sb = tools.find((t) => t.name === "audit_sandbox_run")!;
  const out = await sb.run({ command: "id" }, ctx);
  assert.equal(out.ok, false);
  assert.match(out.content, /sandbox unavailable/);
});

test("fastPath: live secret confirmed, placeholder needs validation, value never recorded", () => {
  const r = fastPath([
    hit({}),
    hit({ file: "docs/readme.md", line: 9 }),
    hit({ tool: "osv", ruleId: "GHSA-1", file: "package-lock.json", line: 1, cls: "dep" }),
    hit({ tool: "opengrep", ruleId: "x", deterministic: false }),
    hit({}),
  ]);
  assert.equal(r.records.length, 3);
  assert.equal(r.hints.length, 1);
  assert.equal(r.records[0]!.verdict, "confirmed");
  assert.equal(r.records[1]!.verdict, "needs_validation");
  assert.match(fingerprintOf(hit({})), /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/);
});

test("finalizeConfirmed downgrades and bounds severity", () => {
  const c = fastPath([hit({})]).records[0] as Confirmed;
  const base = { severityModel: "impact" as const, viabilityRequired: false };
  const ok = finalizeConfirmed({ ...c, severity: { ...c.severity, impact: { score: "low", reason: "" }, overall_severity: "critical" } }, base);
  assert.equal(ok.verdict, "confirmed");
  if (ok.verdict === "confirmed") assert.equal(ok.severity.overall_severity, "low");
  assert.equal(finalizeConfirmed({ ...c, production_viable: "unknown" }, base).verdict, "needs_validation");
  assert.equal(finalizeConfirmed(c, { ...base, viabilityRequired: true }).verdict, "needs_validation");
  const dyn = { ...c, evidence_vector: [{ source: "dyn" as const, state: "confirmed" as const, ref: "r" }] };
  assert.equal(finalizeConfirmed(dyn, base).verdict, "needs_validation");
});
