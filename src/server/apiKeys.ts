/**
 * Local API keys for the public REST API (src/protocol/publicApi.ts).
 * Keys are shown once at creation and stored only as SHA-256 hashes;
 * verification compares hashes with timingSafeEqual over the full table.
 */
import crypto from "node:crypto";
import { database } from "./sqliteStore.js";

export interface ApiKeyRecord {
  id: string;
  name: string;
  /** SHA-256 hex of the full key. Never persist or log the raw key. */
  keyHash: string;
  /** First characters of the raw key, shown in the UI to identify it. */
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface CreatedApiKey extends ApiKeyInfo {
  /** Raw key — returned exactly once; only its hash is stored. */
  key: string;
}

const KEY_PREFIX = "lm_live_";

function ensureTable(): void {
  database().exec(`CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );`);
}

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

function rowToInfo(row: Record<string, unknown>): ApiKeyInfo {
  return {
    id: String(row.id),
    name: String(row.name),
    prefix: String(row.prefix),
    createdAt: String(row.created_at),
    ...(typeof row.last_used_at === "string" && row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    ...(typeof row.revoked_at === "string" && row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}

function allRows(): Record<string, unknown>[] {
  ensureTable();
  return database()
    .prepare("SELECT id, name, key_hash, prefix, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC")
    .all() as Record<string, unknown>[];
}

export function createApiKey(rawName: unknown): CreatedApiKey {
  ensureTable();
  const name = (typeof rawName === "string" && rawName.trim() ? rawName.trim() : "API key").slice(0, 80);
  const id = `key_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  const key = `${KEY_PREFIX}${crypto.randomBytes(24).toString("base64url")}`;
  const createdAt = new Date().toISOString();
  database()
    .prepare("INSERT INTO api_keys (id, name, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, name, hashKey(key), key.slice(0, KEY_PREFIX.length + 6), createdAt);
  return { id, name, prefix: key.slice(0, KEY_PREFIX.length + 6), createdAt, key };
}

export function listApiKeys(): ApiKeyInfo[] {
  return allRows().map(rowToInfo);
}

export function revokeApiKey(id: string): boolean {
  ensureTable();
  const revokedAt = new Date().toISOString();
  const result = database()
    .prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(revokedAt, id);
  return Number(result.changes) > 0;
}

/**
 * Verify a Bearer token. Active keys get last_used_at stamped. The compare is
 * timing-safe per key (few rows in a local app; no early exit on mismatch).
 */
export function verifyApiKey(key: string): ApiKeyRecord | undefined {
  if (typeof key !== "string" || !key.startsWith(KEY_PREFIX)) return undefined;
  ensureTable();
  const rows = allRows();
  const hash = Buffer.from(hashKey(key), "hex");
  for (const row of rows) {
    const stored = Buffer.from(String(row.key_hash), "hex");
    if (stored.length === hash.length && crypto.timingSafeEqual(stored, hash)) {
      if (typeof row.revoked_at === "string" && row.revoked_at) return undefined;
      const lastUsedAt = new Date().toISOString();
      database().prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(lastUsedAt, String(row.id));
      return {
        id: String(row.id),
        name: String(row.name),
        keyHash: String(row.key_hash),
        prefix: String(row.prefix),
        createdAt: String(row.created_at),
        lastUsedAt,
      };
    }
  }
  return undefined;
}