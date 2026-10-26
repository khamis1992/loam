import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ScanTelemetry } from "../telemetry.js";
import { distillSkill, toSkillDoc } from "../selfharden.js";

test("scan telemetry keeps a bounded ring and summarizes health", () => {
  const t = new ScanTelemetry();
  for (let i = 0; i < 520; i++) {
    t.record({ at: new Date().toISOString(), scan: "sca_scan", target: "repo", durationMs: 100 + i, findings: i % 3,
      engines: [{ tool: "osv", status: i % 7 === 0 ? "unavailable" : "ok" }], ...(i === 400 ? { budgetHit: "wall-clock" } : {}) });
  }
  assert.equal(t.entries().length, 500, "ring cap");
  const snap = t.snapshot();
  assert.equal(snap.total, 500);
  assert.ok(snap.slowest[0]!.durationMs >= snap.slowest[4]!.durationMs);
  assert.equal(snap.budgetHits, 1);
  assert.ok(snap.engineHealth["osv"]!.degraded > 0);
});

test("skill distillation: success + 3+ steps, deduped, candidate-only", () => {
  const ok = distillSkill({ goal: "Audit a dependency tree", outcome: "success", steps: [
    { tool: "sca_scan", summary: "scan lockfiles" }, { tool: "sca_scan", summary: "scan lockfiles" },
    { tool: "sbom_generate", summary: "emit SBOM" }, { tool: "secrets_scan", summary: "check prompt assets" },
  ] });
  assert.ok(ok);
  assert.equal(ok!.status, "candidate");
  assert.equal(ok!.slug.startsWith("learned-audit-a-dependency"), true);
  const doc = toSkillDoc(ok!);
  assert.ok(doc.startsWith("---\n"));
  assert.ok(doc.includes("1. **sca_scan**"));
  assert.ok(doc.includes("supply-chain scan before activation"), "gate stated in the doc");
  assert.equal(distillSkill({ goal: "x", outcome: "partial", steps: [] }), null);
  assert.equal(distillSkill({ goal: "x", outcome: "success", steps: [{ tool: "a", summary: "s" }] }), null);
});

import { contextPackEnabled, packContext } from "../contextPack.js";
import { rowsJson, owaspExpected } from "../bench/drivers.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("contextPack: flag-gated, bounded, header per file", () => {
  assert.equal(contextPackEnabled({}), false);
  assert.equal(contextPackEnabled({ LOAM_CONTEXT_PACK: "1" }), true);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "loam-cp-"));
  try {
    fs.writeFileSync(path.join(d, "a.ts"), "export const a = 1;\n");
    fs.mkdirSync(path.join(d, "node_modules"));
    fs.writeFileSync(path.join(d, "node_modules", "skipme.ts"), "nope");
    const packed = packContext({ root: d });
    assert.equal(packed.files, 1);
    assert.ok(packed.text.startsWith("a.ts\n-------\n"));
    assert.ok(!packed.text.includes("skipme"));
    const capped = packContext({ root: d, maxFiles: 0 });
    assert.equal(capped.files, 0);
    assert.equal(capped.truncated, true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("bench drivers: rowsJson validates shape; owaspExpected parses the CSV", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "loam-dr-"));
  try {
    const rowsPath = path.join(d, "rows.json");
    fs.writeFileSync(rowsPath, JSON.stringify([
      { id: "a", expected: "vulnerable", actual: "finding" },
      { id: "b", expected: "benign", actual: "clean", fpTrap: true },
      { id: "bad", expected: "nonsense", actual: "finding" },
    ]));
    const rows = rowsJson(rowsPath);
    assert.equal(rows.length, 2);
    const csv = path.join(d, "expectedresults.csv");
    fs.writeFileSync(csv, "# test name, category, real vulnerability, CWE, ...\nBenchmarkTest00001,crypto-secure,true,CWE-327\nBenchmarkTest00002,cookie-secure,false,CWE-1004\n");
    const owasp = owaspExpected(csv, { BenchmarkTest00001: "finding", BenchmarkTest00002: "clean" });
    assert.deepEqual(owasp.map((r) => [r.expected, r.actual]), [["vulnerable", "finding"], ["benign", "clean"]]);
  } finally { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
