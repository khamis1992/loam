/**
 * Benchmark fixture drivers (ALL_SERVICES §20). External datasets are never
 * vendored; a driver converts a locally-downloaded fixture into BenchRows the
 * uniform scorer consumes. Drivers shipped here:
 *  - owaspExpected: OWASP BenchmarkJava/Python `expectedresults-{kind}.csv`
 *  - rowsJson: generic {id, expected, actual, cwe?, fpTrap?} JSON (used by the
 *    recorded selfscan baseline and any custom corpus).
 */
import fs from "node:fs";
import type { BenchRow } from "./score.js";

/** OWASP Benchmark `expectedresults-*` CSV: # test name, category, real vulnerability, ... */
export function owaspExpected(csvPath: string, actualByTest: Record<string, "finding" | "clean">): BenchRow[] {
  const text = fs.readFileSync(csvPath, "utf8");
  const rows: BenchRow[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const cells = line.split(",").map((c) => c.trim());
    const id = cells[0];
    if (!id || !id.startsWith("BenchmarkTest")) continue;
    // Column 3 is the real-vulnerability flag: "true" = vulnerable case.
    const isVulnerable = cells[2]?.toLowerCase() === "true";
    rows.push({
      id,
      expected: isVulnerable ? "vulnerable" : "benign",
      actual: actualByTest[id] ?? "clean",
      ...(cells[1]?.startsWith("CWE") ? {} : {}),
    });
  }
  return rows;
}

/** Generic driver: a JSON array of rows (the selfscan baseline format). */
export function rowsJson(jsonPath: string): BenchRow[] {
  const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as BenchRow[];
  if (!Array.isArray(parsed)) throw new Error("rowsJson expects an array");
  return parsed.filter((r) => r && typeof r.id === "string" && (r.expected === "vulnerable" || r.expected === "benign") && (r.actual === "finding" || r.actual === "clean"));
}
