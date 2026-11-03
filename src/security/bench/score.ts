/**
 * Uniform benchmark scorer (ALL_SERVICES §20): one BenchScore shape for every
 * dataset, computed from per-case verdicts. External fixtures only — GPL suites
 * (OWASP) and giant datasets (CyberGym) are never vendored; a driver feeds rows in.
 * This is the engine upgrade gate (§23-10): a bump that regresses a recorded
 * baseline must not promote.
 */
export interface BenchRow {
  /** Stable case id in the dataset (e.g. "BenchmarkTest00001"). */
  id: string;
  /** Ground truth: the case contains a real (vulnerable) or benign behavior. */
  expected: "vulnerable" | "benign";
  /** What the scanner under test said: finding or clean. */
  actual: "finding" | "clean";
  /** True CWE when known (per-CWE breakdown). */
  cwe?: string;
  /** FP-trap marker (Real-Vuln style): benign cases designed to look vulnerable. */
  fpTrap?: boolean;
}

export interface BenchScore {
  dataset: string;
  cases: number;
  tp: number; fp: number; fn: number; tn: number;
  precision: number; recall: number; f1: number; f2: number;
  tpr: number; fpr: number; youdenJ: number;
  fpTrapPassRate?: number;
  perCwe?: Record<string, { tp: number; fp: number; fn: number }>;
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

export function score(dataset: string, rows: BenchRow[]): BenchScore {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const trapsTotal = rows.filter((r) => r.fpTrap).length;
  let trapsPassed = 0;
  const cwe: Record<string, { tp: number; fp: number; fn: number }> = {};
  for (const row of rows) {
    const isFinding = row.actual === "finding";
    const isVulnerable = row.expected === "vulnerable";
    if (isFinding && isVulnerable) { tp++; if (row.cwe) cwe[row.cwe] = bump(cwe[row.cwe], "tp"); }
    else if (isFinding && !isVulnerable) { fp++; if (row.cwe) cwe[row.cwe] = bump(cwe[row.cwe], "fp"); }
    else if (!isFinding && isVulnerable) { fn++; if (row.cwe) cwe[row.cwe] = bump(cwe[row.cwe], "fn"); }
    else tn++;
    if (row.fpTrap && !isFinding) trapsPassed++;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const f2 = 5 * precision + recall === 0 ? 0 : (5 * precision * recall) / (4 * precision + recall);
  const tpr = tp + fn === 0 ? 0 : tp / (tp + fn);
  const fpr = fp + tn === 0 ? 0 : fp / (fp + tn);
  return {
    dataset, cases: rows.length, tp, fp, fn, tn,
    precision: r3(precision), recall: r3(recall), f1: r3(f1), f2: r3(f2),
    tpr: r3(tpr), fpr: r3(fpr), youdenJ: r3(tpr - fpr),
    ...(trapsTotal > 0 ? { fpTrapPassRate: r3(trapsPassed / trapsTotal) } : {}),
    ...(Object.keys(cwe).length ? { perCwe: cwe } : {}),
  };
}
const bump = (c: { tp: number; fp: number; fn: number } | undefined, k: "tp" | "fp" | "fn"): { tp: number; fp: number; fn: number } => {
  const cur = c ?? { tp: 0, fp: 0, fn: 0 };
  return { ...cur, [k]: cur[k] + 1 };
};

/** Upgrade gate: every metric must hold or improve vs the recorded baseline. */
export function gatesHold(current: BenchScore, baseline: BenchScore): { ok: boolean; regressions: string[] } {
  const regressions: string[] = [];
  for (const key of ["recall", "f2", "youdenJ"] as const) {
    if (current[key] < baseline[key] - 1e-9) regressions.push(`${key}: ${current[key]} < ${baseline[key]}`);
  }
  if (baseline.fpTrapPassRate !== undefined && (current.fpTrapPassRate ?? 0) < baseline.fpTrapPassRate - 1e-9) {
    regressions.push(`fpTrapPassRate: ${current.fpTrapPassRate} < ${baseline.fpTrapPassRate}`);
  }
  return { ok: regressions.length === 0, regressions };
}
