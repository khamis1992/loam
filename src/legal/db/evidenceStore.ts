import { DatabaseSync } from "node:sqlite";
import { FieldCipher, type KeyProvider } from "../crypto.js";
import type { Contradiction, EvidenceDocument, FactAssertion, TimelineEvent } from "../evidence/types.js";

export const EVIDENCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS evidence_documents (
  id TEXT PRIMARY KEY,
  matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  payload_enc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_documents_matter ON evidence_documents(matter_id, imported_at);
CREATE TABLE IF NOT EXISTS fact_assertions (
  id TEXT PRIMARY KEY,
  matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_enc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fact_assertions_matter ON fact_assertions(matter_id, status);
CREATE TABLE IF NOT EXISTS timeline_events (
  id TEXT PRIMARY KEY,
  matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  sort_date TEXT NOT NULL,
  payload_enc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timeline_events_matter ON timeline_events(matter_id, sort_date);
CREATE TABLE IF NOT EXISTS contradictions (
  id TEXT PRIMARY KEY,
  matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  payload_enc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contradictions_matter ON contradictions(matter_id, severity);
`;

export class EvidenceStore {
  private readonly cipher: FieldCipher;
  constructor(private readonly db: DatabaseSync, keys: KeyProvider) { this.cipher = new FieldCipher(keys); }

  saveDocument(document: EvidenceDocument): void {
    this.db.prepare("INSERT INTO evidence_documents(id,matter_id,sha256,imported_at,payload_enc) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_enc=excluded.payload_enc")
      .run(document.id, document.matterId, document.sha256, document.importedAt, this.cipher.sealJson(document, `evidence-document:${document.id}`));
  }

  getDocument(id: string): EvidenceDocument | undefined {
    const row = this.db.prepare("SELECT payload_enc FROM evidence_documents WHERE id=?").get(id) as { payload_enc?: string } | undefined;
    return row?.payload_enc ? this.cipher.openJson<EvidenceDocument>(row.payload_enc, `evidence-document:${id}`) : undefined;
  }

  listDocuments(matterId: string): EvidenceDocument[] {
    const rows = this.db.prepare("SELECT id FROM evidence_documents WHERE matter_id=? ORDER BY imported_at").all(matterId) as Array<{ id: string }>;
    return rows.map((row) => this.getDocument(row.id)!).filter(Boolean);
  }

  saveFacts(facts: FactAssertion[]): void { this.saveMany("fact_assertions", facts, "fact"); }
  listFacts(matterId: string): FactAssertion[] { return this.listMany("fact_assertions", matterId, "fact"); }
  saveTimeline(events: TimelineEvent[]): void { this.saveMany("timeline_events", events, "timeline"); }
  listTimeline(matterId: string): TimelineEvent[] { return this.listMany("timeline_events", matterId, "timeline"); }
  saveContradictions(items: Contradiction[]): void { this.saveMany("contradictions", items, "contradiction"); }
  listContradictions(matterId: string): Contradiction[] { return this.listMany("contradictions", matterId, "contradiction"); }

  private saveMany(table: "fact_assertions" | "timeline_events" | "contradictions", items: Array<{ id: string; matterId: string }>, kind: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`DELETE FROM ${table} WHERE matter_id=?`).run(items[0]?.matterId ?? "");
      const placeholders = table === "timeline_events" ? "?,?,?,?" : "?,?,?,?,?";
      const insert = this.db.prepare(`INSERT INTO ${table}(id,matter_id,${table === "fact_assertions" ? "kind,status" : table === "timeline_events" ? "sort_date" : "kind,severity"},payload_enc) VALUES(${placeholders})`);
      for (const item of items) {
        const extra = table === "timeline_events" ? [(item as TimelineEvent).sortDate] : table === "fact_assertions" ? [(item as FactAssertion).kind, (item as FactAssertion).status] : [(item as Contradiction).kind, (item as Contradiction).severity];
        insert.run(item.id, item.matterId, ...extra, this.cipher.sealJson(item, `${kind}:${item.id}`));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private listMany<T extends { id: string }>(table: "fact_assertions" | "timeline_events" | "contradictions", matterId: string, kind: string): T[] {
    const rows = this.db.prepare(`SELECT id FROM ${table} WHERE matter_id=?`).all(matterId) as Array<{ id: string }>;
    return rows.map((row) => {
      const record = this.db.prepare(`SELECT payload_enc FROM ${table} WHERE id=?`).get(row.id) as { payload_enc: string };
      return this.cipher.openJson<T>(record.payload_enc, `${kind}:${row.id}`);
    });
  }
}
