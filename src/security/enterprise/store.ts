import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface TenantRecord {
  tenantId: string;
  kind: string;
  id: string;
  data: unknown;
  updatedAt: string;
}

export class EnterpriseStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("CREATE TABLE IF NOT EXISTS records(tenant_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(tenant_id, kind, id))");
  }

  put(tenantId: string, kind: string, id: string, data: unknown): TenantRecord {
    if (![tenantId, kind, id].every((value) => /^[A-Za-z0-9_.@-]{1,128}$/.test(value))) throw new Error("invalid tenant record identity");
    const updatedAt = new Date().toISOString();
    this.db.prepare("INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,kind,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at").run(tenantId, kind, id, JSON.stringify(data), updatedAt);
    return { tenantId, kind, id, data, updatedAt };
  }

  get(tenantId: string, kind: string, id: string): TenantRecord | null {
    const row = this.db.prepare("SELECT * FROM records WHERE tenant_id=? AND kind=? AND id=?").get(tenantId, kind, id) as { data: string; updated_at: string } | undefined;
    return row ? { tenantId, kind, id, data: JSON.parse(row.data), updatedAt: row.updated_at } : null;
  }

  list(tenantId: string, kind: string, limit = 100): TenantRecord[] {
    return this.db.prepare("SELECT * FROM records WHERE tenant_id=? AND kind=? ORDER BY updated_at DESC LIMIT ?").all(tenantId, kind, Math.min(Math.max(limit, 1), 500)).map((row) => {
      const value = row as { id: string; data: string; updated_at: string };
      return { tenantId, kind, id: value.id, data: JSON.parse(value.data), updatedAt: value.updated_at };
    });
  }

  close(): void { this.db.close(); }
}
