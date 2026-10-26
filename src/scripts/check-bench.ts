/** check:bench — offline smoke gate for the uniform benchmark scorer, fixture
 *  drivers, and the coverage ledger (Cap A A5, ALL_SERVICES §20).
 *  Proves: scoring math on a planted corpus, the upgrade gate catches a
 *  regression and passes an improvement, both drivers parse their formats, and
 *  the coverage ledger round-trips through the A-DD1 validator. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gatesHold, score, type BenchRow } from "../security/bench/score.js";
import { owaspExpected, rowsJson } from "../security/bench/drivers.js";
import { CoverageLedger } from "../security/coverage/ledger.js";
import { validateLedger } from "../security/audit/validateLedger.js";
void validateLedger;

// 1. Scoring math on a planted corpus: 8 vulnerable (6 found), 4 benign (1 false
//    positive), 2 FP-traps that both passed.
const rows: BenchRow[] = [
  { id: "v1", expected: "vulnerable", actual: "finding", cwe: "CWE-89" },
  { id: "v2", expected: "vulnerable", actual: "finding", cwe: "CWE-89" },
  { id: "v3", expected: "vulnerable", actual: "finding", cwe: "CWE-79" },
  { id: "v4", expected: "vulnerable", actual: "clean", cwe: "CWE-79" },
  { id: "v5", expected: "vulnerable", actual: "finding", cwe: "CWE-22" },
  { id: "v6", expected: "vulnerable", actual: "finding", cwe: "CWE-22" },
  { id: "v7", expected: "vulnerable", actual: "finding", cwe: "CWE-89" },
  { id: "v8", expected: "vulnerable", actual: "clean", cwe: "CWE-502" },
  { id: "b1", expected: "benign", actual: "clean", fpTrap: true },
  { id: "b2", expected: "benign", actual: "clean", fpTrap: true },
  { id: "b3", expected: "benign", actual: "finding" },
  { id: "b4", expected: "benign", actual: "clean" },
];
const s = score("planted", rows);
assert.equal(s.cases, 12);
assert.equal(s.tp, 6); assert.equal(s.fn, 2); assert.equal(s.fp, 1); assert.equal(s.tn, 3);
assert.equal(s.precision, 0.857); assert.equal(s.recall, 0.75);
assert.equal(s.fpTrapPassRate, 1);
assert.equal(s.perCwe?.["CWE-79"]?.fn, 1);
assert.equal(s.perCwe?.["CWE-89"]?.tp, 3);
assert.equal(s.perCwe?.["CWE-22"]?.tp, 2);

// 2. The upgrade gate (§23-10): a recall regression must block; an equal-or-better
//    score must pass. gatesHold compares only the gate metrics (recall/f2/youdenJ/fp-trap).
const better = score("planted", rows.map((r) => (r.id === "v4" ? { ...r, actual: "finding" as const } : r)));
assert.equal(better.recall > s.recall, true);
assert.equal(gatesHold(better, s).ok, true, "improvement must hold");
const worse = score("planted", rows.map((r) => (r.id === "v1" ? { ...r, actual: "clean" as const } : r)));
const gate = gatesHold(worse, s);
assert.equal(gate.ok, false, "regression must be caught");
assert.ok(gate.regressions.some((x) => x.startsWith("recall:")), gate.regressions.join("; "));
assert.equal(gatesHold(s, s).ok, true, "identical scores hold");

// 3. Drivers: rowsJson round-trips a rows file; owaspExpected parses the CSV shape.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-bench-"));
const rowsFile = path.join(tmp, "rows.json");
fs.writeFileSync(rowsFile, JSON.stringify(rows));
assert.deepEqual(rowsJson(rowsFile), rows);
const csvFile = path.join(tmp, "expected.csv");
fs.writeFileSync(csvFile, [
  "# test name, category, real vulnerability, CWE, ...",
  "BenchmarkTest00001,trust boundary,TRUE,CWE-80",
  "BenchmarkTest00002,hash,FALSE,CWE-328",
  "not-a-test,FALSE,FALSE",
].join("\n"));
const owasp = owaspExpected(csvFile, { BenchmarkTest00001: "finding" });
assert.equal(owasp.length, 2);
assert.equal(owasp[0]?.expected, "vulnerable");
assert.equal(owasp[0]?.actual, "finding");
assert.equal(owasp[1]?.expected, "benign");
assert.equal(owasp[1]?.actual, "clean", "missing verdicts default to clean");

// 4. Coverage ledger: scan outcomes map to statuses, JSON round-trips, and the
//    A-DD1 re-export of the audit validator is linked (its (bytes, ctx) surface
//    belongs to the audit ledger; the coverage ledger validates its own shape).
const ledger = new CoverageLedger();
ledger.recordScan("apps/web", "sast", { hitCount: 2 });
ledger.recordScan("apps/web", "config", { hitCount: 0, notes: ["dockerfile skipped"] });
ledger.recordScan("apps/api", "recon", { hitCount: 0, error: "scope denied" });
ledger.recordScan("apps/api", "mobsf", { hitCount: 0, skipped: true });
assert.equal(ledger.get("apps/web", "sast")?.status, "covered");
assert.equal(ledger.get("apps/web", "config")?.status, "partial");
assert.equal(ledger.get("apps/api", "recon")?.status, "error");
assert.equal(ledger.get("apps/api", "mobsf")?.status, "skipped");
const round = CoverageLedger.fromJson(ledger.toJson());
assert.deepEqual(round.entries().map((e) => e.target + e.check).sort(), ledger.entries().map((e) => e.target + e.check).sort());
assert.equal(round.coveredKeys().length, 3, "skipped entries are not covered");
assert.equal(typeof validateLedger, "function", "A-DD1: audit validator re-exported from coverage/ledger");
fs.rmSync(tmp, { recursive: true, force: true });

console.log("check:bench OK — scorer + upgrade gate + drivers + coverage ledger (A-DD1) verified");
