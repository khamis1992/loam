import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDir } from "../config.js";

/** In-process caches to forget when the connection is reset (test isolation). */
const resets: Array<() => void> = [];
export function onDatabaseReset(reset: () => void): void { resets.push(reset); }

let connection: DatabaseSync | undefined;
export function database(): DatabaseSync {
  if (connection) return connection;
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "manus.db"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
  db.exec(`CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  connection = db;
  try {
    transaction(() => {
      if (db.prepare("SELECT value FROM metadata WHERE key='legacy-import'").get()) return;
      const legacy = path.join(dir, "db.json");
      if (fs.existsSync(legacy)) {
        const parsed = JSON.parse(fs.readFileSync(legacy, "utf8")) as Record<string, unknown>;
        for (const kind of ["tasks", "projects", "schedules"]) {
          const rows = parsed[kind] ?? [];
          if (!Array.isArray(rows)) throw new Error(`Invalid legacy ${kind}; migration aborted`);
          for (const row of rows) {
            if (!row || typeof row.id !== "string") throw new Error(`Invalid legacy ${kind} entry`);
            if (kind === "tasks") {
              row.messages ??= []; row.steps ??= [];
              if (!Array.isArray(row.messages) || !Array.isArray(row.steps) || typeof row.createdAt !== "string" || typeof row.prompt !== "string") {
                throw new Error(`Invalid legacy task ${row.id}; migration aborted`);
              }
            }
            db.prepare("INSERT INTO entities(kind,id,payload) VALUES(?,?,?)").run(kind, row.id, JSON.stringify(row));
          }
        }
        const backup = path.join(dir, "db.pre-sqlite.json");
        if (!fs.existsSync(backup)) fs.copyFileSync(legacy, backup, fs.constants.COPYFILE_EXCL);
      }
      db.prepare("INSERT INTO metadata(key,value) VALUES('legacy-import','1')").run();
    });
  } catch (error) { db.close(); connection = undefined; throw error; }
  return db;
}
export function transaction<T>(fn: () => T): T {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try { const result = fn(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function putEntity(kind: string, value: { id: string }): void {
  database().prepare("INSERT INTO entities(kind,id,payload) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload")
    .run(kind, value.id, JSON.stringify(value));
}
export function getEntity<T>(kind: string, id: string): T | undefined {
  const row = database().prepare("SELECT payload FROM entities WHERE kind=? AND id=?").get(kind, id);
  return row ? JSON.parse(String(row.payload)) as T : undefined;
}
export function allEntities<T>(kind: string): T[] {
  return database().prepare("SELECT payload FROM entities WHERE kind=? ORDER BY rowid DESC").all(kind)
    .map((r) => JSON.parse(String(r.payload)) as T);
}
export function removeEntity(kind: string, id: string): boolean {
  return Number(database().prepare("DELETE FROM entities WHERE kind=? AND id=?").run(kind, id).changes) > 0;
}
export function closeDb(): void {
  connection?.close();
  connection = undefined;
  for (const reset of resets) reset();
}

/** Test helper: forget the current connection. The next `database()` call opens a
 *  fresh file, so a test can isolate its data without touching the app's real
 *  `data/` folder. */
export function resetDb(): void {
  closeDb();
}

/** Prevent two local server processes from independently owning the same task queue. */
export function acquireRuntimeLease(): void {
  transaction(() => {
    const row = database().prepare("SELECT value FROM metadata WHERE key='runtime-pid'").get();
    if (row) {
      const pid = Number(row.value);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid runtime owner record");
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
      if (alive) throw new Error(`Another runtime owns this data directory (PID ${pid})`);
    }
    database().prepare("INSERT INTO metadata(key,value) VALUES('runtime-pid',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(process.pid));
  });
}
export function releaseRuntimeLease(): void {
  database().prepare("DELETE FROM metadata WHERE key='runtime-pid' AND value=?").run(String(process.pid));
}
/** A consistent daily snapshot; unfinished temporary files are never treated as backups. */
export function backupDatabase(): string {
  const dir = path.join(dataDir(), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `manus-${new Date().toISOString().slice(0, 10)}.db`);
  if (!fs.existsSync(target)) {
    const staging = `${target}.${process.pid}.${Date.now()}.tmp`;
    database().exec(`VACUUM INTO '${staging.replace(/'/g, "''")}'`);
    fs.renameSync(staging, target);
  }
  return target;
}
