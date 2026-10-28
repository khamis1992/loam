import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface CorpusSnapshot {
  id: string;
  createdAt: string;
  contentSha256: string;
  versions: number;
}

export function createCorpusSnapshot(db: DatabaseSync, opts: { persist: boolean; now?: () => Date }): CorpusSnapshot {
  const rows = db.prepare("SELECT avid, text_sha256, effective_from, effective_to, provenance, source_json FROM article_versions ORDER BY avid").all() as Array<Record<string, unknown>>;
  const canonical = rows.map((row) => ({
    avid: String(row.avid), textSha256: String(row.text_sha256), effectiveFrom: String(row.effective_from),
    effectiveTo: row.effective_to === null ? null : String(row.effective_to), provenance: String(row.provenance), source: JSON.parse(String(row.source_json)),
  }));
  const contentSha256 = crypto.createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
  const id = `CS-${contentSha256.slice(0, 16)}`;
  const createdAt = (opts.now?.() ?? new Date()).toISOString();
  if (opts.persist) db.prepare("INSERT OR IGNORE INTO corpus_snapshots(id,created_at,content_sha256,versions) VALUES(?,?,?,?)").run(id, createdAt, contentSha256, rows.length);
  return { id, createdAt, contentSha256, versions: rows.length };
}
