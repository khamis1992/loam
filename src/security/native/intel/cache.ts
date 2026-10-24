/**
 * TTL cache for external intel sources (KEV, EPSS). SQLite via node:sqlite —
 * the same primitive runStore uses; no new dependencies. Lazy expiry on read,
 * purge + trim to the newest MAX_ROWS on open. Negative markers are cached so
 * unknown CVEs are not re-asked every scan.
 * Layout follows cve-intel's cache.rs (MIT/Apache-2.0, Fazmin/cve-intel).
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../../../config.js";

const MAX_ROWS = 10_000;

export class IntelCache {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const file = dbPath ?? IntelCache.defaultPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
    this.db.exec("CREATE TABLE IF NOT EXISTS intel_cache(cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at REAL NOT NULL, expires_at REAL NOT NULL)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_intel_expires ON intel_cache(expires_at)");
    this.purge();
  }

  static defaultPath(): string { return path.join(DATA_DIR, "security-intel", "cache.db"); }

  /** Drop expired rows, then keep only the MAX_ROWS newest-expiring ones. */
  private purge(): void {
    const now = Date.now() / 1000;
    this.db.prepare("DELETE FROM intel_cache WHERE expires_at <= ?").run(now);
    this.db.prepare(`DELETE FROM intel_cache WHERE cache_key NOT IN (SELECT cache_key FROM intel_cache ORDER BY expires_at DESC LIMIT ${MAX_ROWS})`).run();
  }

  /** Parsed JSON value, or null when absent/expired/malformed. */
  get<T>(key: string): T | null {
    const row = this.db.prepare("SELECT payload, expires_at FROM intel_cache WHERE cache_key=?").get(key) as { payload: string; expires_at: number } | undefined;
    if (!row || row.expires_at <= Date.now() / 1000) return null;
    try { return JSON.parse(row.payload) as T; } catch { return null; }
  }

  set(key: string, value: unknown, ttlSec: number): void {
    const now = Date.now() / 1000;
    this.db.prepare("INSERT OR REPLACE INTO intel_cache VALUES (?,?,?,?)").run(key, JSON.stringify(value), now, now + ttlSec);
  }

  clear(): void { this.db.prepare("DELETE FROM intel_cache").run(); }

  stats(): { entries: number; bytes: number } {
    const r = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)),0) AS b FROM intel_cache").get() as { n: number; b: number };
    return { entries: r.n, bytes: r.b };
  }

  close(): void { try { this.db.close(); } catch { /* already closed */ } }
}

/** Process-wide default cache; tests construct their own instance instead. */
let shared: IntelCache | null = null;
export const defaultCache = (): IntelCache => (shared ??= new IntelCache());
