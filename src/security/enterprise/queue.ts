import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface EnterpriseJob {
  id: string;
  tenantId: string;
  type: string;
  payload: unknown;
  status: "queued" | "leased" | "completed" | "retry" | "dead";
  attempts: number;
  maxAttempts: number;
  leaseOwner?: string;
}

export class EnterpriseQueue {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS jobs(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
      idempotency TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
      available_at INTEGER NOT NULL, lease_owner TEXT, lease_until INTEGER, updated_at INTEGER NOT NULL,
      UNIQUE(tenant_id,idempotency))`);
  }

  enqueue(tenantId: string, type: string, payload: unknown, idempotency: string, maxAttempts = 5): EnterpriseJob {
    if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(type) || !/^[A-Za-z0-9_.:-]{1,200}$/.test(idempotency)) throw new Error("invalid job type or idempotency key");
    const now = Date.now();
    const job: EnterpriseJob = { id: `JOB-${randomBytes(12).toString("hex")}`, tenantId, type, payload, status: "queued", attempts: 0, maxAttempts };
    this.db.prepare("INSERT INTO jobs(id,tenant_id,type,payload,idempotency,status,attempts,max_attempts,available_at,updated_at) VALUES(?,?,?,?,?,?,0,?,?,?)").run(job.id, tenantId, type, JSON.stringify(payload), idempotency, job.status, maxAttempts, now, now);
    return job;
  }

  claim(tenantId: string, workerId: string, allowedTypes: string[], leaseMs = 30_000): EnterpriseJob | null {
    if (!allowedTypes.length) return null;
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const placeholders = allowedTypes.map(() => "?").join(",");
      const row = this.db.prepare(`SELECT * FROM jobs WHERE tenant_id=? AND status IN ('queued','retry') AND type IN (${placeholders}) AND available_at<=? ORDER BY available_at LIMIT 1`).get(tenantId, ...allowedTypes, now) as { id: string; attempts: number } | undefined;
      if (!row) { this.db.exec("COMMIT"); return null; }
      const changed = this.db.prepare("UPDATE jobs SET status='leased',lease_owner=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND status IN ('queued','retry')").run(workerId, now + leaseMs, now, row.id);
      if (!changed.changes) { this.db.exec("ROLLBACK"); return null; }
      this.db.exec("COMMIT");
      return this.get(tenantId, row.id);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  heartbeat(tenantId: string, id: string, workerId: string, leaseMs = 30_000): boolean {
    return this.db.prepare("UPDATE jobs SET lease_until=?,updated_at=? WHERE tenant_id=? AND id=? AND lease_owner=? AND status='leased'").run(Date.now() + leaseMs, Date.now(), tenantId, id, workerId).changes === 1;
  }

  complete(tenantId: string, id: string, workerId: string): boolean {
    return this.db.prepare("UPDATE jobs SET status='completed',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE tenant_id=? AND id=? AND lease_owner=? AND status='leased'").run(Date.now(), tenantId, id, workerId).changes === 1;
  }

  fail(tenantId: string, id: string, workerId: string, retryDelayMs = 1000): EnterpriseJob {
    const job = this.get(tenantId, id);
    if (!job || job.leaseOwner !== workerId) throw new Error("job lease mismatch");
    const dead = job.attempts >= job.maxAttempts;
    this.db.prepare("UPDATE jobs SET status=?,available_at=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE tenant_id=? AND id=? AND lease_owner=?").run(dead ? "dead" : "retry", Date.now() + retryDelayMs, Date.now(), tenantId, id, workerId);
    return this.get(tenantId, id)!;
  }

  recoverExpired(now = Date.now()): number {
    return Number(this.db.prepare("UPDATE jobs SET status='retry',available_at=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE status='leased' AND lease_until<?").run(now, now, now).changes);
  }

  get(tenantId: string, id: string): EnterpriseJob | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE tenant_id=? AND id=?").get(tenantId, id) as { type: string; payload: string; status: EnterpriseJob["status"]; attempts: number; max_attempts: number; lease_owner?: string } | undefined;
    return row ? { id, tenantId, type: row.type, payload: JSON.parse(row.payload), status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts, ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}) } : null;
  }

  health(tenantId: string): Record<string, number> {
    const rows = this.db.prepare("SELECT status,COUNT(*) AS count FROM jobs WHERE tenant_id=? GROUP BY status").all(tenantId);
    return Object.fromEntries(rows.map((row) => { const value = row as { status: string; count: number }; return [value.status, value.count]; }));
  }

  close(): void { this.db.close(); }
}
