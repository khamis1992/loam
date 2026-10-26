import type { DatabaseSync } from "node:sqlite";

export interface LegalMigration {
  version: number;
  sql: string;
}

export interface LegalSchemaMigration {
  schema: string;
  version: number;
  migrations?: LegalMigration[];
}

export function migrateLegalDatabase(db: DatabaseSync, input: LegalSchemaMigration): void {
  if (!Number.isInteger(input.version) || input.version < 1) throw new Error("invalid legal schema version");
  for (const migration of input.migrations ?? []) {
    if (!Number.isInteger(migration.version) || migration.version <= input.version || migration.version < 2) throw new Error("invalid legal migration version");
  }
  const target = Math.max(input.version, ...(input.migrations ?? []).map((m) => m.version));
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (current > target) throw new Error(`legal schema ${current} is newer than supported ${target}`);
    if (current === 0) {
      db.exec(input.schema);
      db.exec(`PRAGMA user_version=${input.version}`);
    }
    for (const migration of [...(input.migrations ?? [])].sort((a, b) => a.version - b.version)) {
      if (migration.version <= current) continue;
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version=${migration.version}`);
    }
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(target));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
