import type { CoverageEntry } from "./ledger.js";
import type { MasvsCoverage } from "../mobile/masvs.js";

export type UnifiedStatus = "covered" | "partial" | "error" | "skipped" | "not-tested" | "not-applicable";

export interface UnifiedCoverageEntry {
  surface: "web" | "mobile" | "api";
  target: string;
  control: string;
  role?: string;
  status: UnifiedStatus;
  reason: string;
  evidenceIds: string[];
}

export interface UnifiedCoverageSummary {
  total: number;
  covered: number;
  partial: number;
  errors: number;
  unknown: number;
  notApplicable: number;
  coveragePercent: number;
  clean: boolean;
}

export function fromMasvs(entries: MasvsCoverage[]): UnifiedCoverageEntry[] {
  return entries.map((entry) => ({ surface: "mobile", target: entry.controlId, control: entry.controlId, status: entry.status, reason: entry.reason, evidenceIds: [...entry.evidenceIds] }));
}

export function fromScannerCoverage(entries: CoverageEntry[], surface: "web" | "api" = "web"): UnifiedCoverageEntry[] {
  return entries.map((entry) => ({ surface, target: entry.target, control: entry.check, status: entry.status, reason: entry.notes?.join("; ") || entry.status, evidenceIds: [] }));
}

export function summarizeUnifiedCoverage(entries: UnifiedCoverageEntry[]): UnifiedCoverageSummary {
  const applicable = entries.filter((entry) => entry.status !== "not-applicable");
  const covered = applicable.filter((entry) => entry.status === "covered").length;
  const partial = applicable.filter((entry) => entry.status === "partial" || entry.status === "skipped").length;
  const errors = applicable.filter((entry) => entry.status === "error").length;
  const unknown = applicable.filter((entry) => entry.status === "not-tested").length;
  const notApplicable = entries.length - applicable.length;
  return {
    total: entries.length,
    covered,
    partial,
    errors,
    unknown,
    notApplicable,
    coveragePercent: applicable.length ? Math.round((covered / applicable.length) * 1000) / 10 : 100,
    clean: applicable.length > 0 && covered === applicable.length && errors === 0 && unknown === 0,
  };
}

export function mergeUnifiedCoverage(...groups: UnifiedCoverageEntry[][]): UnifiedCoverageEntry[] {
  const rank: Record<UnifiedStatus, number> = { "not-tested": 0, error: 1, skipped: 2, partial: 3, covered: 4, "not-applicable": 5 };
  const entries = new Map<string, UnifiedCoverageEntry>();
  for (const entry of groups.flat()) {
    if (!entry.reason.trim()) throw new Error("coverage reason is required");
    const key = `${entry.surface}\n${entry.target}\n${entry.control}\n${entry.role ?? ""}`;
    const current = entries.get(key);
    if (!current || rank[entry.status] < rank[current.status]) entries.set(key, { ...entry, evidenceIds: [...entry.evidenceIds] });
    else if (entry.status === current.status) current.evidenceIds = [...new Set([...current.evidenceIds, ...entry.evidenceIds])];
  }
  return [...entries.values()];
}
