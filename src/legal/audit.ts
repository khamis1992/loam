/**
 * Append-only, hash-chained audit log (matters DB table `audit_log`, guarded by
 * UPDATE/DELETE triggers). Each row's hash = sha256(prevHash | canonical row),
 * so editing or removing a row breaks `verifyChain`. Details are metadata only;
 * `assertMetadataOnly` rejects long free text so contract wording can never be
 * logged by mistake.
 */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AuditAction, AuditEvent } from "./types.js";

export const GENESIS = "0".repeat(64);
const MAX_DETAIL_CHARS = 200;

export type AuditDetails = Record<string, string | number | boolean | null>;

export function assertMetadataOnly(details: AuditDetails): void {
  for (const [k, v] of Object.entries(details)) {
    if (typeof v === "string" && v.length > MAX_DETAIL_CHARS) throw new Error(`audit detail "${k}" is too long to be metadata (${v.length} chars)`);
  }
}

function canonical(e: Omit<AuditEvent, "hash" | "prevHash" | "seq"> & { seq: number }): string {
  const keys = Object.keys(e.details).sort();
  const details = Object.fromEntries(keys.map((k) => [k, e.details[k] ?? null]));
  return JSON.stringify([e.seq, e.at, e.actor, e.action, e.matterId, e.subject, details]);
}

export function hashEvent(prevHash: string, e: Omit<AuditEvent, "hash" | "prevHash" | "seq"> & { seq: number }): string {
  return crypto.createHash("sha256").update(`${prevHash}|${canonical(e)}`, "utf8").digest("hex");
}

export class AuditLog {
  constructor(private readonly db: DatabaseSync, private readonly now: () => Date = () => new Date()) {}

  append(actor: string, action: AuditAction, matterId: string | null, subject: string, details: AuditDetails = {}): AuditEvent {
    assertMetadataOnly(details);
    if (subject.length > MAX_DETAIL_CHARS) throw new Error("audit subject too long");
    const last = this.db.prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as { seq: number; hash: string } | undefined;
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? GENESIS;
    const base = { seq, at: this.now().toISOString(), actor, action, matterId, subject, details };
    const hash = hashEvent(prevHash, base);
    this.db.prepare("INSERT INTO audit_log(seq,at,actor,action,matter_id,subject,details_json,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(seq, base.at, actor, action, matterId, subject, JSON.stringify(details), prevHash, hash);
    return { ...base, prevHash, hash };
  }

  list(opts: { matterId?: string; limit?: number } = {}): AuditEvent[] {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 5000);
    const rows = (opts.matterId
      ? this.db.prepare("SELECT * FROM audit_log WHERE matter_id=? ORDER BY seq DESC LIMIT ?").all(opts.matterId, limit)
      : this.db.prepare("SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?").all(limit)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      seq: Number(r.seq), at: String(r.at), actor: String(r.actor), action: String(r.action) as AuditAction,
      matterId: r.matter_id === null ? null : String(r.matter_id), subject: String(r.subject),
      details: JSON.parse(String(r.details_json)) as AuditDetails, prevHash: String(r.prev_hash), hash: String(r.hash),
    }));
  }

  /** Recompute the whole chain. Returns the first broken seq, or null when intact. */
  verifyChain(): number | null {
    const rows = this.db.prepare("SELECT * FROM audit_log ORDER BY seq").all() as Array<Record<string, unknown>>;
    let prev = GENESIS;
    let expectSeq = 1;
    for (const r of rows) {
      const seq = Number(r.seq);
      if (seq !== expectSeq || String(r.prev_hash) !== prev) return seq;
      const recomputed = hashEvent(prev, {
        seq, at: String(r.at), actor: String(r.actor), action: String(r.action) as AuditAction,
        matterId: r.matter_id === null ? null : String(r.matter_id), subject: String(r.subject),
        details: JSON.parse(String(r.details_json)) as AuditDetails,
      });
      if (recomputed !== String(r.hash)) return seq;
      prev = recomputed;
      expectSeq++;
    }
    return null;
  }
}
