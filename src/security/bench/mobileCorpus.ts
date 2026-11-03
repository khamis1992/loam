import { score, type BenchScore } from "./score.js";

export interface MobileBenchCase {
  id: string;
  family: "authorization" | "business";
  expected: "vulnerable" | "benign";
  variant: string;
  cwe: string;
}

export interface MobileBenchOutcome {
  actual: "finding" | "clean" | "inconclusive" | "unavailable";
  durationMs: number;
}

export interface MobileBenchResult {
  score: BenchScore;
  total: number;
  inconclusive: number;
  unavailable: number;
  durationMs: number;
  perCase: Array<MobileBenchCase & MobileBenchOutcome>;
}

export const MOBILE_SCALE_CORPUS: readonly MobileBenchCase[] = [
  { id: "bola-read-exposed", family: "authorization", expected: "vulnerable", variant: "read", cwe: "CWE-639" },
  { id: "bola-read-denied", family: "authorization", expected: "benign", variant: "read", cwe: "CWE-639" },
  { id: "bola-tenant-exposed", family: "authorization", expected: "vulnerable", variant: "tenant", cwe: "CWE-639" },
  { id: "bola-tenant-denied", family: "authorization", expected: "benign", variant: "tenant", cwe: "CWE-639" },
  { id: "bola-anonymous-exposed", family: "authorization", expected: "vulnerable", variant: "anonymous", cwe: "CWE-306" },
  { id: "bola-anonymous-denied", family: "authorization", expected: "benign", variant: "anonymous", cwe: "CWE-306" },
  { id: "bola-missing-marker", family: "authorization", expected: "benign", variant: "ambiguous", cwe: "CWE-639" },
  { id: "bola-owner-denied", family: "authorization", expected: "benign", variant: "control", cwe: "CWE-639" },
  { id: "business-order-bypass", family: "business", expected: "vulnerable", variant: "order", cwe: "CWE-841" },
  { id: "business-order-enforced", family: "business", expected: "benign", variant: "order", cwe: "CWE-841" },
  { id: "business-quota-bypass", family: "business", expected: "vulnerable", variant: "quota", cwe: "CWE-770" },
  { id: "business-quota-enforced", family: "business", expected: "benign", variant: "quota", cwe: "CWE-770" },
  { id: "business-replay-effect", family: "business", expected: "vulnerable", variant: "replay", cwe: "CWE-294" },
  { id: "business-replay-idempotent", family: "business", expected: "benign", variant: "replay", cwe: "CWE-294" },
  { id: "business-offline-bypass", family: "business", expected: "vulnerable", variant: "offline", cwe: "CWE-345" },
  { id: "business-offline-enforced", family: "business", expected: "benign", variant: "offline", cwe: "CWE-345" },
  { id: "business-recovery-bypass", family: "business", expected: "vulnerable", variant: "recovery", cwe: "CWE-640" },
  { id: "business-recovery-enforced", family: "business", expected: "benign", variant: "recovery", cwe: "CWE-640" },
  { id: "business-refund-bypass", family: "business", expected: "vulnerable", variant: "refund", cwe: "CWE-840" },
  { id: "business-refund-enforced", family: "business", expected: "benign", variant: "refund", cwe: "CWE-840" },
] as const;

export async function runMobileScaleCorpus(runner: (testCase: MobileBenchCase) => Promise<MobileBenchOutcome>): Promise<MobileBenchResult> {
  const perCase: MobileBenchResult["perCase"] = [];
  for (const testCase of MOBILE_SCALE_CORPUS) perCase.push({ ...testCase, ...(await runner(testCase)) });
  const rows = perCase.filter((item) => item.actual === "finding" || item.actual === "clean").map((item) => ({ id: item.id, expected: item.expected, actual: item.actual as "finding" | "clean", cwe: item.cwe }));
  return {
    score: score("mobile-scale-independent-v1", rows),
    total: perCase.length,
    inconclusive: perCase.filter((item) => item.actual === "inconclusive").length,
    unavailable: perCase.filter((item) => item.actual === "unavailable").length,
    durationMs: perCase.reduce((total, item) => total + item.durationMs, 0),
    perCase,
  };
}
