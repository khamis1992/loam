/**
 * One scanner coverage ledger for every engine (ALL_SERVICES P0), keyed by the
 * existing coverageKey(target, check). A run's scanners record what they covered
 * and how it ended; compareFindings() consumes coveredKeys() to separate
 * "not observed" from "not covered". JSON round-trips for persistence.
 */
import { coverageKey } from "../findings.js";

export type CoverageStatus = "covered" | "partial" | "error" | "skipped";

export interface CoverageEntry {
  target: string;
  check: string;
  engine: string;
  status: CoverageStatus;
  findingCount: number;
  scannedAt: string;
  notes?: string[];
}

export interface ScanOutcome { hitCount: number; error?: string; notes?: string[]; skipped?: boolean }

export class CoverageLedger {
  private readonly byKey = new Map<string, CoverageEntry>();

  record(e: CoverageEntry): void {
    this.byKey.set(coverageKey(e.target, e.check), { ...e, notes: [...(e.notes ?? [])] });
  }

  /** Record one scanner result; error implies partial coverage, never silent success. */
  recordScan(target: string, engine: string, outcome: ScanOutcome, now = new Date().toISOString()): CoverageEntry {
    const status: CoverageStatus = outcome.skipped ? "skipped" : outcome.error ? "error" : (outcome.notes?.length ? "partial" : "covered");
    const entry: CoverageEntry = {
      target, check: engine, engine, status, findingCount: outcome.hitCount, scannedAt: now,
      ...(outcome.error || outcome.notes?.length ? { notes: [...(outcome.error ? [outcome.error] : []), ...(outcome.notes ?? [])] } : {}),
    };
    this.record(entry);
    return entry;
  }

  get(target: string, check: string): CoverageEntry | undefined { return this.byKey.get(coverageKey(target, check)); }
  entries(): CoverageEntry[] { return [...this.byKey.values()]; }
  coveredKeys(): string[] { return this.entries().filter((e) => e.status !== "skipped").map((e) => coverageKey(e.target, e.check)); }

  toJson(): string { return JSON.stringify({ version: 1, entries: this.entries() }, null, 2); }
  static fromJson(text: string): CoverageLedger {
    const ledger = new CoverageLedger();
    const parsed = JSON.parse(text) as { version?: number; entries?: CoverageEntry[] };
    for (const e of parsed.entries ?? []) {
      if (e && typeof e.target === "string" && typeof e.check === "string" && typeof e.engine === "string") {
        ledger.record({ ...e, status: e.status ?? "covered", findingCount: e.findingCount ?? 0, scannedAt: e.scannedAt ?? "" });
      }
    }
    return ledger;
  }
}

// A-DD1 (MISSING §4): the audit coverage ledger validator is the authority.
export { validateLedger } from "../audit/validateLedger.js";
