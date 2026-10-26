/**
 * Confidential matter storage: matters, contracts, clauses, review records,
 * the per-run retrieval ledger and the audit log, in `<DATA_DIR>/legal/matters.db`.
 * Every column that can carry client text is an AES-256-GCM envelope bound to
 * its row id; clear columns hold only ids, enums, dates and hashes.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AuditLog } from "./audit.js";
import { FieldCipher, type KeyProvider } from "./crypto.js";
import { MATTERS_SCHEMA, MATTERS_SCHEMA_VERSION } from "./schema.js";
import { migrateLegalDatabase } from "./db/migrations.js";
import { EvidenceStore, EVIDENCE_SCHEMA } from "./db/evidenceStore.js";
import { PipelineStore, PIPELINE_SCHEMA } from "./db/pipelineStore.js";
import type { Clause, ClauseCategory, Confidentiality, ContractDoc, EgressPolicy, Matter, MatterParty, ReviewRecord } from "./types.js";

export interface NewMatter {
  title: string;
  kind: Matter["kind"];
  confidentiality?: Confidentiality;
  asOf?: string;
  court?: Matter["court"];
  parties?: MatterParty[];
  retainUntil?: string | null;
}

type Row = Record<string, unknown>;
const CONFIDENTIALITY: readonly Confidentiality[] = ["public", "internal", "confidential", "privileged"];
const EGRESS: readonly EgressPolicy[] = ["local_only", "cloud_redacted", "cloud_full"];

/** Today in Asia/Qatar (UTC+3, no DST) as YYYY-MM-DD. */
export function qatarToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
}

export class MattersStore {
  readonly db: DatabaseSync;
  readonly audit: AuditLog;
  readonly evidence: EvidenceStore;
  readonly pipeline: PipelineStore;
  private readonly cipher: FieldCipher;

  constructor(dbPath: string, keys: KeyProvider, private readonly now: () => Date = () => new Date()) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;");
    migrateLegalDatabase(this.db, { schema: MATTERS_SCHEMA, version: MATTERS_SCHEMA_VERSION, migrations: [{ version: 2, sql: EVIDENCE_SCHEMA }, { version: 3, sql: PIPELINE_SCHEMA }] });
    this.cipher = new FieldCipher(keys);
    this.audit = new AuditLog(this.db, now);
    this.evidence = new EvidenceStore(this.db, keys);
    this.pipeline = new PipelineStore(this.db, keys);
  }

  close(): void { this.db.close(); }

  private iso(): string { return this.now().toISOString(); }

  // ---- matters --------------------------------------------------------------

  createMatter(input: NewMatter, actor: string): Matter {
    if (!input.title.trim()) throw new Error("matter title is required");
    const confidentiality = input.confidentiality ?? "confidential";
    if (!CONFIDENTIALITY.includes(confidentiality)) throw new Error("invalid confidentiality");
    const at = this.iso();
    const m: Matter = {
      id: `mt-${crypto.randomBytes(6).toString("hex")}`,
      title: input.title.trim(),
      kind: input.kind,
      confidentiality,
      egress: "local_only",
      asOf: input.asOf ?? qatarToday(this.now()),
      ...(input.court ? { court: input.court } : {}),
      parties: input.parties ?? [],
      createdAt: at,
      updatedAt: at,
      retainUntil: input.retainUntil ?? null,
    };
    this.db.prepare("INSERT INTO matters(id,kind,confidentiality,egress,created_at,updated_at,retain_until,payload_enc) VALUES(?,?,?,?,?,?,?,?)")
      .run(m.id, m.kind, m.confidentiality, m.egress, at, at, m.retainUntil, this.cipher.sealJson(m, `matter:${m.id}`));
    this.audit.append(actor, "matter.create", m.id, "matter created", { kind: m.kind, confidentiality });
    return m;
  }

  getMatter(id: string): Matter | undefined {
    const r = this.db.prepare("SELECT payload_enc FROM matters WHERE id=?").get(id) as Row | undefined;
    return r ? this.cipher.openJson<Matter>(String(r.payload_enc), `matter:${id}`) : undefined;
  }

  listMatters(): Matter[] {
    return (this.db.prepare("SELECT id, payload_enc FROM matters ORDER BY updated_at DESC").all() as Row[])
      .map((r) => this.cipher.openJson<Matter>(String(r.payload_enc), `matter:${String(r.id)}`));
  }

  /**
   * Update a matter. `egress` changes are accepted ONLY with `viaUi: true`
   * (HTTP route from the settings UI) — no agent tool can widen egress.
   */
  updateMatter(id: string, patch: Partial<Omit<Matter, "id" | "createdAt">>, actor: string, viaUi: boolean): Matter {
    const cur = this.getMatter(id);
    if (!cur) throw new Error(`matter ${id} not found`);
    if (patch.egress !== undefined && patch.egress !== cur.egress) {
      if (!viaUi) throw new Error("egress can only be changed by the user in the Legal settings UI");
      if (!EGRESS.includes(patch.egress)) throw new Error("invalid egress");
    }
    if (patch.confidentiality !== undefined && !CONFIDENTIALITY.includes(patch.confidentiality)) throw new Error("invalid confidentiality");
    const next: Matter = { ...cur, ...patch, id, createdAt: cur.createdAt, updatedAt: this.iso() };
    this.db.prepare("UPDATE matters SET kind=?, confidentiality=?, egress=?, updated_at=?, retain_until=?, payload_enc=? WHERE id=?")
      .run(next.kind, next.confidentiality, next.egress, next.updatedAt, next.retainUntil, this.cipher.sealJson(next, `matter:${id}`), id);
    const details: Record<string, string> = {};
    if (patch.egress !== undefined && patch.egress !== cur.egress) details.egress = `${cur.egress}->${patch.egress}`;
    if (patch.confidentiality !== undefined && patch.confidentiality !== cur.confidentiality) details.confidentiality = `${cur.confidentiality}->${patch.confidentiality}`;
    this.audit.append(actor, patch.egress !== undefined && patch.egress !== cur.egress ? "egress.decision" : "matter.update", id, "matter updated", details);
    return next;
  }

  /** Purge a matter and everything under it (secure_delete on). The audit trail stays. */
  deleteMatter(id: string, actor: string): boolean {
    const res = this.db.prepare("DELETE FROM matters WHERE id=?").run(id);
    if (Number(res.changes) > 0) this.audit.append(actor, "purge", id, "matter purged", {});
    return Number(res.changes) > 0;
  }

  purgeExpired(actor: string): string[] {
    const today = qatarToday(this.now());
    const ids = (this.db.prepare("SELECT id FROM matters WHERE retain_until IS NOT NULL AND retain_until < ?").all(today) as Row[]).map((r) => String(r.id));
    for (const id of ids) this.deleteMatter(id, actor);
    return ids;
  }

  // ---- contracts & clauses ------------------------------------------------------

  addContract(matterId: string, input: { fileName: string; mime: string; text: string; language: ContractDoc["language"] }, actor: string): ContractDoc {
    if (!this.getMatter(matterId)) throw new Error(`matter ${matterId} not found`);
    if (!input.text.trim()) throw new Error("contract text is empty");
    const doc: ContractDoc = {
      id: `ct-${crypto.randomBytes(6).toString("hex")}`,
      matterId,
      fileName: path.basename(input.fileName),
      mime: input.mime,
      sha256: crypto.createHash("sha256").update(input.text, "utf8").digest("hex"),
      language: input.language,
      text: input.text,
      importedAt: this.iso(),
    };
    this.db.prepare("INSERT INTO contracts(id,matter_id,sha256,imported_at,payload_enc) VALUES(?,?,?,?,?)")
      .run(doc.id, matterId, doc.sha256, doc.importedAt, this.cipher.sealJson(doc, `contract:${doc.id}`));
    this.audit.append(actor, "contract.import", matterId, "contract imported", { contractId: doc.id, sha256: doc.sha256, chars: doc.text.length });
    return doc;
  }

  getContract(id: string): ContractDoc | undefined {
    const r = this.db.prepare("SELECT payload_enc FROM contracts WHERE id=?").get(id) as Row | undefined;
    return r ? this.cipher.openJson<ContractDoc>(String(r.payload_enc), `contract:${id}`) : undefined;
  }

  listContracts(matterId: string): Array<Pick<ContractDoc, "id" | "fileName" | "sha256" | "importedAt" | "language">> {
    return (this.db.prepare("SELECT id FROM contracts WHERE matter_id=? ORDER BY imported_at").all(matterId) as Row[])
      .map((r) => this.getContract(String(r.id)))
      .filter((d): d is ContractDoc => d !== undefined)
      .map(({ id, fileName, sha256, importedAt, language }) => ({ id, fileName, sha256, importedAt, language }));
  }

  saveClauses(contractId: string, clauses: Clause[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM clauses WHERE contract_id=?").run(contractId);
      const ins = this.db.prepare("INSERT INTO clauses(id,contract_id,idx,categories,payload_enc) VALUES(?,?,?,?,?)");
      for (const c of clauses) ins.run(c.id, contractId, c.index, c.categories.join(","), this.cipher.sealJson(c, `clause:${c.id}`));
      this.db.exec("COMMIT");
    } catch (err) { this.db.exec("ROLLBACK"); throw err; }
  }

  clauses(contractId: string): Clause[] {
    return (this.db.prepare("SELECT id, payload_enc FROM clauses WHERE contract_id=? ORDER BY idx").all(contractId) as Row[])
      .map((r) => this.cipher.openJson<Clause>(String(r.payload_enc), `clause:${String(r.id)}`));
  }

  clauseCategories(contractId: string): Array<{ id: string; categories: ClauseCategory[] }> {
    return (this.db.prepare("SELECT id, categories FROM clauses WHERE contract_id=? ORDER BY idx").all(contractId) as Row[])
      .map((r) => ({ id: String(r.id), categories: String(r.categories).split(",").filter(Boolean) as ClauseCategory[] }));
  }

  // ---- retrieval ledger ------------------------------------------------------------

  ledgerAdd(taskId: string, avids: string[]): void {
    const ins = this.db.prepare("INSERT OR IGNORE INTO retrieval_ledger(task_id, avid, at) VALUES(?,?,?)");
    const at = this.iso();
    for (const a of avids) ins.run(taskId, a, at);
  }

  ledger(taskId: string): Set<string> {
    return new Set((this.db.prepare("SELECT avid FROM retrieval_ledger WHERE task_id=?").all(taskId) as Row[]).map((r) => String(r.avid)));
  }

  // ---- reviews ------------------------------------------------------------------------

  saveReview(rec: ReviewRecord): void {
    this.db.prepare(`INSERT INTO reviews(id,matter_id,state,verified_sha256,approved_sha256,payload_enc) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, verified_sha256=excluded.verified_sha256, approved_sha256=excluded.approved_sha256, payload_enc=excluded.payload_enc`)
      .run(rec.id, rec.matterId, rec.state, rec.verifiedSha256 ?? null, rec.approvedSha256 ?? null, this.cipher.sealJson(rec, `review:${rec.id}`));
  }

  getReview(id: string): ReviewRecord | undefined {
    const r = this.db.prepare("SELECT payload_enc FROM reviews WHERE id=?").get(id) as Row | undefined;
    return r ? this.cipher.openJson<ReviewRecord>(String(r.payload_enc), `review:${id}`) : undefined;
  }

  reviewsOf(matterId: string): ReviewRecord[] {
    return (this.db.prepare("SELECT id FROM reviews WHERE matter_id=?").all(matterId) as Row[])
      .map((r) => this.getReview(String(r.id)))
      .filter((r): r is ReviewRecord => r !== undefined);
  }
}
