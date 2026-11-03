import { scoreCve } from "./native/intel/risk.js";

export type ExploitabilityState = "affected" | "not-affected" | "reachable" | "not-reachable" | "unknown";

export interface ExposureInput {
  cveId: string;
  cvss: number;
  epss: number;
  inKev: boolean;
  state: ExploitabilityState;
  evidenceIds: string[];
  assetSensitivity: number;
  fixAvailable: boolean;
}

export function assessExposure(input: ExposureInput): { state: ExploitabilityState; score: number; urgency: string; evidenceIds: string[] } {
  const base = scoreCve({ cveId: input.cveId, cvssScore: input.cvss, epssProbability: input.epss, ...(input.inKev ? { kev: { cve: input.cveId, dateAdded: "", dueDate: "", ransomware: false } } : {}) });
  if (input.state === "not-affected") return { state: input.state, score: 0, urgency: "document non-affected evidence", evidenceIds: input.evidenceIds };
  if (input.state === "unknown" && input.evidenceIds.length === 0) return { state: input.state, score: base.risk_score, urgency: "establish applicability evidence", evidenceIds: [] };
  const reachabilityFactor = input.state === "not-reachable" ? 0.25 : 1;
  const sensitivityFactor = 0.75 + Math.min(Math.max(input.assetSensitivity, 0), 10) / 40;
  const fixFactor = input.fixAvailable ? 1 : 1.1;
  const score = Math.min(100, Math.round(base.risk_score * reachabilityFactor * sensitivityFactor * fixFactor * 100) / 100);
  const urgency = input.state === "not-reachable" ? "verify reachability and monitor" : score >= 76 ? "remediate immediately" : score >= 50 ? "remediate this cycle" : "schedule and verify";
  return { state: input.state, score, urgency, evidenceIds: input.evidenceIds };
}

export function compareExposureReleases(previous: string[], current: string[], coverageComplete: boolean): { new: string[]; persistent: string[]; resolved: string[]; unverified: string[] } {
  const before = new Set(previous);
  const now = new Set(current);
  return {
    new: current.filter((id) => !before.has(id)),
    persistent: current.filter((id) => before.has(id)),
    resolved: coverageComplete ? previous.filter((id) => !now.has(id)) : [],
    unverified: coverageComplete ? [] : previous.filter((id) => !now.has(id)),
  };
}
