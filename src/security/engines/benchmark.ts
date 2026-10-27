export interface EngineBenchCase {
  id: string;
  expected: "vulnerable" | "benign";
  actual: "finding" | "clean" | "inconclusive" | "unavailable";
  durationMs: number;
}

export function evaluateEngineBenchmark(cases: EngineBenchCase[]): { cases: number; tp: number; tn: number; fp: number; fn: number; inconclusive: number; unavailable: number; precision: number; recall: number; durationMs: number; passed: boolean } {
  const tp = cases.filter((item) => item.expected === "vulnerable" && item.actual === "finding").length;
  const tn = cases.filter((item) => item.expected === "benign" && item.actual === "clean").length;
  const fp = cases.filter((item) => item.expected === "benign" && item.actual === "finding").length;
  const fn = cases.filter((item) => item.expected === "vulnerable" && item.actual !== "finding").length;
  const inconclusive = cases.filter((item) => item.actual === "inconclusive").length;
  const unavailable = cases.filter((item) => item.actual === "unavailable").length;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return { cases: cases.length, tp, tn, fp, fn, inconclusive, unavailable, precision, recall, durationMs: cases.reduce((sum, item) => sum + item.durationMs, 0), passed: fp === 0 && fn === 0 && unavailable === 0 };
}
