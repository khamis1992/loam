import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Page, PageKind, SearchHit } from "./types.js";

/**
 * Search index for one wiki root, kept in its own sqlite file (not manus.db).
 * Scoring is BM25 over a small `pages` table, computed in JS so nothing depends
 * on the FTS5 build of the bundled sqlite. The index is derived data: it can be
 * deleted and rebuilt from the markdown files at any time.
 */
const handles = new Map<string, DatabaseSync>();

function open(root: string): DatabaseSync {
  const hit = handles.get(root);
  if (hit) return hit;
  fs.mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(path.join(root, ".index.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;");
  db.exec(`CREATE TABLE IF NOT EXISTS pages (
    id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, tags TEXT NOT NULL,
    body TEXT NOT NULL, updated TEXT NOT NULL, superseded INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, id))`);
  handles.set(root, db);
  return db;
}

export function closeIndex(root?: string): void {
  for (const [key, db] of handles) {
    if (root && key !== root) continue;
    try { db.close(); } catch { /* already closed */ }
    handles.delete(key);
  }
}

export function upsert(root: string, page: Page): void {
  open(root)
    .prepare(
      `INSERT INTO pages(id,kind,title,tags,body,updated,superseded) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(kind,id) DO UPDATE SET title=excluded.title, tags=excluded.tags, body=excluded.body,
         updated=excluded.updated, superseded=excluded.superseded`,
    )
    .run(page.meta.id, page.meta.kind, page.meta.title, page.meta.tags.join(" "), page.body, page.meta.updated, page.meta.supersededBy ? 1 : 0);
}

export function remove(root: string, kind: PageKind, id: string): void {
  open(root).prepare("DELETE FROM pages WHERE kind=? AND id=?").run(kind, id);
}

export function reset(root: string): void {
  open(root).exec("DELETE FROM pages");
}

const tokenize = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];

interface Row { id: string; kind: PageKind; title: string; tags: string; body: string }

export function search(root: string, query: string, opts: { limit?: number; kind?: PageKind; includeSuperseded?: boolean } = {}): SearchHit[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];
  const rows = open(root)
    .prepare(`SELECT id,kind,title,tags,body FROM pages WHERE (?1 IS NULL OR kind=?1) AND (?2 = 1 OR superseded = 0)`)
    .all(opts.kind ?? null, opts.includeSuperseded ? 1 : 0) as unknown as Row[];
  if (!rows.length) return [];
  const docs = rows.map((r) => tokenize(`${r.title} ${r.title} ${r.tags} ${r.body}`));
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const term of terms) df.set(term, docs.filter((d) => d.includes(term)).length);
  const k1 = 1.2;
  const b = 0.75;
  const hits: SearchHit[] = [];
  rows.forEach((row, i) => {
    const doc = docs[i]!;
    let score = 0;
    for (const term of terms) {
      const f = doc.filter((w) => w === term).length;
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (rows.length - n + 0.5) / (n + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / avg));
    }
    if (score > 0) hits.push({ id: row.id, kind: row.kind, title: row.title, score: Math.round(score * 1000) / 1000, snippet: snippet(row.body, terms) });
  });
  return hits.sort((a, c) => c.score - a.score || a.id.localeCompare(c.id)).slice(0, Math.min(opts.limit ?? 8, 50));
}

function snippet(body: string, terms: string[]): string {
  const lower = body.toLowerCase();
  const at = terms.map((t) => lower.indexOf(t)).filter((n) => n >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - 60);
  return body.slice(start, start + 200).replace(/\s+/g, " ").trim();
}
