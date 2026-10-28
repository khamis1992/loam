import type { DatabaseSync } from "node:sqlite";
import type { LegalCorpus } from "../corpusStore.js";
import { CITABLE_PROVENANCE } from "../types.js";

export interface CoverageEntry {
  legKey: string;
  titleAr: string;
  requiredFor: string[];
  maxReviewAgeDays?: number;
}

export interface CoverageIssue {
  legKey: string;
  titleAr: string;
  reason: "missing" | "unverified" | "stale" | "not_in_force";
}

export interface CoverageReport {
  status: "unconfigured" | "complete" | "incomplete";
  matterKind: string;
  asOf: string;
  entries: number;
  issues: CoverageIssue[];
  checkedAt: string;
}

export const CORPUS_COVERAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS coverage_entries (
  leg_key TEXT PRIMARY KEY,
  title_ar TEXT NOT NULL,
  required_for TEXT NOT NULL,
  max_review_age_days INTEGER
);
CREATE TABLE IF NOT EXISTS corpus_snapshots (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  content_sha256 TEXT NOT NULL UNIQUE,
  versions INTEGER NOT NULL
);
`;

export function writeCoverageManifest(db: DatabaseSync, entries: CoverageEntry[]): void {
  const keys = new Set<string>();
  for (const entry of entries) {
    if (!entry.legKey.trim() || !entry.titleAr.trim() || entry.requiredFor.length === 0) throw new Error("invalid coverage entry");
    if (keys.has(entry.legKey)) throw new Error(`duplicate coverage entry: ${entry.legKey}`);
    keys.add(entry.legKey);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM coverage_entries").run();
    const insert = db.prepare("INSERT INTO coverage_entries(leg_key,title_ar,required_for,max_review_age_days) VALUES(?,?,?,?)");
    for (const entry of entries) insert.run(entry.legKey, entry.titleAr, JSON.stringify([...new Set(entry.requiredFor)]), entry.maxReviewAgeDays ?? 30);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function readCoverageManifest(db: DatabaseSync): CoverageEntry[] {
  const rows = db.prepare("SELECT * FROM coverage_entries ORDER BY leg_key").all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    legKey: String(row.leg_key), titleAr: String(row.title_ar), requiredFor: JSON.parse(String(row.required_for)) as string[],
    ...(row.max_review_age_days === null ? {} : { maxReviewAgeDays: Number(row.max_review_age_days) }),
  }));
}

export function coverageReport(corpus: LegalCorpus, opts: { asOf: string; matterKind?: string; now?: Date }): CoverageReport {
  const matterKind = opts.matterKind ?? "research";
  const now = opts.now ?? new Date();
  const entries = readCoverageManifest(corpus.db).filter((entry) => entry.requiredFor.includes(matterKind) || entry.requiredFor.includes("*"));
  const issues: CoverageIssue[] = [];
  for (const entry of entries) {
    const legislation = corpus.getLegislation(entry.legKey);
    if (!legislation) {
      issues.push({ legKey: entry.legKey, titleAr: entry.titleAr, reason: "missing" });
      continue;
    }
    const source = legislation.source;
    if (!source.verifiedBy || !source.verifiedAt || !CITABLE_PROVENANCE.has(source.provenance)) {
      issues.push({ legKey: entry.legKey, titleAr: entry.titleAr, reason: "unverified" });
      continue;
    }
    if (legislation.status === "repealed" || legislation.status === "not_yet_in_force") {
      issues.push({ legKey: entry.legKey, titleAr: entry.titleAr, reason: "not_in_force" });
      continue;
    }
    const age = now.getTime() - Date.parse(source.verifiedAt);
    if (!Number.isFinite(age) || age > (entry.maxReviewAgeDays ?? 30) * 86_400_000) {
      issues.push({ legKey: entry.legKey, titleAr: entry.titleAr, reason: "stale" });
    }
  }
  return {
    status: readCoverageManifest(corpus.db).length === 0 ? "unconfigured" : issues.length === 0 ? "complete" : "incomplete",
    matterKind, asOf: opts.asOf, entries: entries.length, issues, checkedAt: now.toISOString(),
  };
}
