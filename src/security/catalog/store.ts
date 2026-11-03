import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { CatalogFilter, VulnerabilityRecord } from "./types.js";

const required = (value: string, label: string): void => { if (!value.trim()) throw new Error(`${label} is required`); };

export function validateVulnerabilityRecord(record: VulnerabilityRecord): void {
  if (!/^[a-z0-9][a-z0-9_.:-]{2,120}$/.test(record.id)) throw new Error("invalid vulnerability id");
  required(record.title, "title");
  required(record.description, "description");
  required(record.validationKey, "validationKey");
  if (!["class", "cve"].includes(record.kind) || !record.platforms.length || !record.cwe.length || !record.detectionMethods.length || !record.evidenceRequired.length) throw new Error("incomplete vulnerability record");
  if (!["info", "low", "medium", "high", "critical"].includes(record.severity) || !["read-only", "approval-required", "disabled"].includes(record.action)) throw new Error("invalid vulnerability severity or action");
  for (const value of [...record.cwe, ...record.capec, ...record.owasp]) required(value, "reference");
}

export class VulnerabilityCatalogStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS vulnerabilities(
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, severity TEXT NOT NULL,
      platforms TEXT NOT NULL, categories TEXT NOT NULL, cwe TEXT NOT NULL, validation_key TEXT NOT NULL,
      action TEXT NOT NULL, document TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_vulnerability_validation ON vulnerabilities(validation_key)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_vulnerability_severity ON vulnerabilities(severity)");
  }

  upsert(record: VulnerabilityRecord): void {
    validateVulnerabilityRecord(record);
    this.db.prepare(`INSERT INTO vulnerabilities(id,kind,title,severity,platforms,categories,cwe,validation_key,action,document,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,severity=excluded.severity,platforms=excluded.platforms,categories=excluded.categories,cwe=excluded.cwe,validation_key=excluded.validation_key,action=excluded.action,document=excluded.document,updated_at=excluded.updated_at`).run(record.id, record.kind, record.title, record.severity, JSON.stringify(record.platforms), JSON.stringify(record.categories), JSON.stringify(record.cwe), record.validationKey, record.action, JSON.stringify(record), new Date().toISOString());
  }

  get(id: string): VulnerabilityRecord | null {
    const row = this.db.prepare("SELECT document FROM vulnerabilities WHERE id=?").get(id) as { document: string } | undefined;
    return row ? JSON.parse(row.document) as VulnerabilityRecord : null;
  }

  list(filter: CatalogFilter = {}): VulnerabilityRecord[] {
    const records = (this.db.prepare("SELECT document FROM vulnerabilities ORDER BY id").all() as Array<{ document: string }>).map((row) => JSON.parse(row.document) as VulnerabilityRecord);
    const query = filter.query?.toLowerCase();
    return records.filter((record) => (!filter.platform || record.platforms.includes(filter.platform)) && (!filter.category || record.categories.includes(filter.category)) && (!filter.cwe || record.cwe.includes(filter.cwe)) && (!filter.validationKey || record.validationKey === filter.validationKey) && (!query || `${record.title} ${record.description} ${record.id}`.toLowerCase().includes(query))).slice(0, Math.min(Math.max(filter.limit ?? 200, 1), 1000));
  }

  stats(): { total: number; byPlatform: Record<string, number>; bySeverity: Record<string, number>; byValidation: Record<string, number> } {
    const records = this.list({ limit: 1000 });
    const byPlatform: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const byValidation: Record<string, number> = {};
    for (const record of records) {
      for (const platform of record.platforms) byPlatform[platform] = (byPlatform[platform] ?? 0) + 1;
      bySeverity[record.severity] = (bySeverity[record.severity] ?? 0) + 1;
      byValidation[record.validationKey] = (byValidation[record.validationKey] ?? 0) + 1;
    }
    return { total: records.length, byPlatform, bySeverity, byValidation };
  }

  close(): void { this.db.close(); }
}
