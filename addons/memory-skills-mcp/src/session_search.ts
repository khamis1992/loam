import { buildMatchQuery, escapeLike, sanitizeQuery } from "./search.js";
import { hasTrigram, rebuildEpisodeTrigram, rowsOf, type Db, type Row } from "./db.js";
import { clamp, snippet } from "./util.js";

export type SessionSearchSource = "fts" | "trigram" | "like";

export interface SessionHit {
  id: string;
  createdAt: string;
  goal: string;
  outcome: string;
  summary: string;
  snippet: string;
  score: number;
  source: SessionSearchSource;
}

const FTS_SNIPPET_OPTS = [-1, "<mark>", "</mark>", "…", 12] as const;

/**
 * Full-text search over past task sessions (episodes).
 *
 * Ranking strategy:
 *   1. FTS5 `unicode61` MATCH with bm25 ranking and `snippet()` highlighting.
 *   2. FTS5 `trigram` substring MATCH (Arabic/CJK friendly) when available.
 *   3. `LIKE` substring fallback otherwise.
 *
 * The query is always sanitized (length-capped and stripped of FTS operators)
 * before it reaches SQL, so untrusted input can never alter the query shape.
 */
export class SessionSearch {
  private readonly trigram: boolean;

  constructor(private readonly db: Db) {
    this.trigram = hasTrigram(db);
  }

  get usesTrigram(): boolean {
    return this.trigram;
  }

  async search(query: string, limit = 20): Promise<SessionHit[]> {
    const clean = sanitizeQuery(query);
    const k = clamp(Math.round(limit), 1, 100);
    if (!clean) return [];

    const fts = this.searchFts(clean, k);
    if (fts.length > 0) return fts;

    if (this.trigram && clean.length >= 3) {
      const trigram = this.searchTrigram(clean, k);
      if (trigram.length > 0) return trigram;
    }

    return this.searchLike(clean, k);
  }

  private searchFts(clean: string, k: number): SessionHit[] {
    const match = buildMatchQuery(clean);
    if (!match) return [];
    const rows = rowsOf(
      this.db,
      `SELECT e.id, e.created_at, e.goal, e.outcome, e.summary,
              snippet(episodes_fts, ${FTS_SNIPPET_OPTS[0]}, '${FTS_SNIPPET_OPTS[1]}', '${FTS_SNIPPET_OPTS[2]}', '${FTS_SNIPPET_OPTS[3]}', ${FTS_SNIPPET_OPTS[4]}) AS snip,
              bm25(episodes_fts) AS rank
         FROM episodes_fts
         JOIN episodes e ON e.id = episodes_fts.id
        WHERE episodes_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
      match,
      k,
    );
    return rows.map((r) => toHit(r, "fts"));
  }

  private searchTrigram(clean: string, k: number): SessionHit[] {
    const rows = rowsOf(
      this.db,
      `SELECT e.id, e.created_at, e.goal, e.outcome, e.summary,
              snippet(episodes_trigram, ${FTS_SNIPPET_OPTS[0]}, '${FTS_SNIPPET_OPTS[1]}', '${FTS_SNIPPET_OPTS[2]}', '${FTS_SNIPPET_OPTS[3]}', ${FTS_SNIPPET_OPTS[4]}) AS snip,
              bm25(episodes_trigram) AS rank
         FROM episodes_trigram
         JOIN episodes e ON e.id = episodes_trigram.id
        WHERE episodes_trigram MATCH ?
        ORDER BY rank
        LIMIT ?`,
      clean,
      k,
    );
    return rows.map((r) => toHit(r, "trigram"));
  }

  private searchLike(clean: string, k: number): SessionHit[] {
    const like = `%${escapeLike(clean)}%`;
    const rows = rowsOf(
      this.db,
      `SELECT id, created_at, goal, outcome, summary, lessons
         FROM episodes
        WHERE goal LIKE ? ESCAPE '\\'
           OR summary LIKE ? ESCAPE '\\'
           OR lessons LIKE ? ESCAPE '\\'
        ORDER BY created_at DESC
        LIMIT ?`,
      like,
      like,
      like,
      k,
    );
    return rows.map((r) => {
      const hit = toHit(r, "like");
      hit.snippet = makeSnippet(String(r["summary"] ?? ""), clean);
      return hit;
    });
  }

  /** Rebuild the optional trigram index from the episodes table. */
  syncIndex(): number {
    return rebuildEpisodeTrigram(this.db);
  }

  /** Rebuild the trigram index only when it has fallen out of sync. */
  syncIndexIfStale(): number {
    if (!this.trigram) return 0;
    const count = (sql: string): number => {
      const row = this.db.prepare(sql).get() as Row | undefined;
      return row ? Number(row["c"] ?? 0) : 0;
    };
    const total = count(`SELECT COUNT(*) AS c FROM episodes`);
    const indexed = count(`SELECT COUNT(*) AS c FROM episodes_trigram`);
    return total === indexed ? indexed : this.syncIndex();
  }
}

/** Server-facing helper: build a searcher and run one sanitized query. */
export async function searchSessions(db: Db, query: string, limit = 20): Promise<SessionHit[]> {
  return new SessionSearch(db).search(query, limit);
}

function toHit(r: Row, source: SessionSearchSource): SessionHit {
  const rank = typeof r["rank"] === "number" && Number.isFinite(r["rank"]) ? r["rank"] : 0;
  return {
    id: String(r["id"]),
    createdAt: String(r["created_at"]),
    goal: String(r["goal"]),
    outcome: String(r["outcome"]),
    summary: String(r["summary"]),
    snippet: String(r["snip"] ?? ""),
    score: -rank,
    source,
  };
}

/** Build a highlighted window around the first literal occurrence of `needle`. */
function makeSnippet(text: string, needle: string, radius = 80): string {
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return snippet(text, 160);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + needle.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}
