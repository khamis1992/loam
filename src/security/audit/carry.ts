/**
 * Carry of prior runs. A repeat audit of the same repository reads the newest earlier run's ledger,
 * findings and source hashes, then gives every unit a `prior_status` and the hunter a short list of
 * findings it already knows. Anything missing or unreadable degrades to "new"; nothing here throws.
 */
import fs from "node:fs";
import path from "node:path";
import type { FindingRecord, LedgerUnit, PriorStatus } from "./types.js";

export const SOURCE_HASHES_FILE = "source-hashes.json";
export type SourceHashes = Record<string, string>;

export interface PriorRun {
  dir: string;
  units: LedgerUnit[];
  findings: FindingRecord[];
  hashes: SourceHashes | null;
}

export interface KnownFinding { fingerprint: string; title: string; verdict: FindingRecord["verdict"] }

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
}

/** Newest earlier run in the same <slug>/run-N layout that finished writing its ledger and findings. */
export function findPriorRun(runDir: string): PriorRun | null {
  const m = /^run-(\d+)$/.exec(path.basename(runDir));
  if (!m) return null; // an explicit output_dir has no sibling history
  const mine = Number(m[1]);
  const parent = path.dirname(runDir);
  let names: string[] = [];
  try { names = fs.readdirSync(parent); } catch { return null; }
  const older = names
    .map((n) => ({ n, k: /^run-(\d+)$/.exec(n) }))
    .filter((x): x is { n: string; k: RegExpExecArray } => x.k !== null && Number(x.k[1]) < mine)
    .sort((a, b) => Number(b.k[1]) - Number(a.k[1]));
  for (const { n } of older) {
    const dir = path.join(parent, n);
    const units = readJson<LedgerUnit[]>(path.join(dir, "coverage-ledger.json"));
    const findings = readJson<FindingRecord[]>(path.join(dir, "findings.json"));
    if (!Array.isArray(units) || !Array.isArray(findings)) continue; // missing ledger: try the one before it
    const hashes = readJson<SourceHashes>(path.join(dir, SOURCE_HASHES_FILE));
    return {
      dir,
      units: units.filter((u) => u && typeof u.coverage_id === "string" && Array.isArray(u.starting_paths)),
      findings: findings.filter((f) => f && typeof f.fingerprint === "string"),
      hashes: hashes && typeof hashes === "object" && !Array.isArray(hashes) ? hashes : null,
    };
  }
  return null;
}

const sameSource = (paths: string[], now: SourceHashes, before: SourceHashes | null): boolean =>
  before !== null && paths.length > 0 && paths.every((p) => now[p] !== undefined && now[p] === before[p]);

/** The prior state of one unit, judged by its coverage id (derived from its refs, so stable across runs). */
export function priorStatusFor(unit: Pick<LedgerUnit, "coverage_id" | "starting_paths">, prior: PriorRun | null, now: SourceHashes): PriorStatus {
  if (!prior) return "new";
  const old = prior.units.find((u) => u.coverage_id === unit.coverage_id);
  if (!old) return "new";
  const same = sameSource([...unit.starting_paths, ...old.starting_paths], now, prior.hashes);
  switch (old.status) {
    case "candidate": {
      const mine = prior.findings.filter((f) => old.result_fingerprints.includes(f.fingerprint));
      if (mine.some((f) => f.verdict === "confirmed")) return same ? "prior_confirmed_same_source" : "prior_confirmed_changed_source";
      if (mine.some((f) => f.verdict === "needs_validation")) return "prior_needs_validation";
      if (mine.length > 0) return same ? "prior_covered_same_source" : "prior_rejected_claim_changed";
      return "new"; // the ledger names findings the findings file no longer has
    }
    case "covered": return same ? "prior_covered_same_source" : "prior_covered_changed_source";
    case "blocked": return "prior_blocked";
    case "deferred": return "prior_deferred";
    case "out_of_scope":
    case "not_applicable": return "prior_out_of_scope";
    default: return "new";
  }
}

/**
 * Findings from the prior run that sit in this unit's files, so the hunter does not report them again.
 * Rejected claims are included only while the source is unchanged; once it changes they may be real.
 */
export function knownFindingsFor(unit: Pick<LedgerUnit, "starting_paths">, prior: PriorRun | null, now: SourceHashes, cap = 20): KnownFinding[] {
  if (!prior) return [];
  const paths = new Set(unit.starting_paths);
  const same = sameSource(unit.starting_paths, now, prior.hashes);
  const out: KnownFinding[] = [];
  for (const f of prior.findings) {
    if (out.length >= cap) break;
    if (f.verdict === "rejected" && !same) continue;
    const files = [...f.trace.map((t) => t.file), ...f.evidence.map((e) => e.file)];
    if (!files.some((p) => paths.has(p))) continue;
    out.push({ fingerprint: f.fingerprint, title: f.title.slice(0, 120), verdict: f.verdict });
  }
  return out;
}
