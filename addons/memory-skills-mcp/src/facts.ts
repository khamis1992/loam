import { rowOf, rowsOf, runStatement, type Db, type Row } from "./db.js";
import { cosine, fromBlob, type Embedder } from "./embed.js";
import { blendedScore, buildMatchQuery, lexicalFromRank, normalizeLexical } from "./search.js";
import { clamp, envValue, newId, nowIso, parseStringList, stringArray } from "./util.js";

export interface Fact {
  id: string;
  createdAt: string;
  updatedAt: string;
  kind: string;
  key: string | null;
  text: string;
  tags: string[];
}

export interface FactHit {
  fact: Fact;
  score: number;
}

export interface FactRememberInput {
  text: string;
  kind?: string;
  tags?: string[];
  key?: string;
}

export type FactAction = "inserted" | "updated" | "merged";

function dedupeThreshold(): number {
  const raw = envValue("MEMSKILLS_DEDUPE");
  const n = raw ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.97;
}

export class Facts {
  constructor(
    private readonly db: Db,
    private readonly embedder: Embedder,
  ) {}

  async remember(input: FactRememberInput): Promise<{ id: string; action: FactAction }> {
    const text = input.text.trim();
    if (!text) throw new Error("fact_remember requires text");
    const kind = (input.kind ?? "note").trim() || "note";
    const tags = input.tags ?? [];
    const key = input.key?.trim() || null;
    const now = nowIso();

    if (key) {
      const row = rowOf(this.db, `SELECT * FROM facts WHERE key = ?`, key);
      if (row) {
        await this.retext(row, text, kind, tags, now);
        return { id: String(row["id"]), action: "updated" };
      }
    } else {
      const exact = rowOf(this.db, `SELECT * FROM facts WHERE text = ?`, text);
      if (exact) {
        await this.retext(exact, text, kind, tags, now);
        return { id: String(exact["id"]), action: "updated" };
      }
    }

    if (this.embedder.configured) {
      const vec = await this.embedder.embed(text);
      if (vec) {
        const near = this.nearest(vec);
        if (near && near.score >= dedupeThreshold()) {
          const row = rowOf(this.db, `SELECT * FROM facts WHERE id = ?`, near.id);
          if (row) {
            await this.retext(row, text, kind, tags, now);
            return { id: near.id, action: "merged" };
          }
        }
        const id = newId("fact");
        this.insert(id, text, kind, tags, key, now, vec);
        return { id, action: "inserted" };
      }
    }

    const id = newId("fact");
    this.insert(id, text, kind, tags, key, now, null);
    return { id, action: "inserted" };
  }

  private insert(id: string, text: string, kind: string, tags: string[], key: string | null, now: string, vec: Float32Array | null): void {
    runStatement(
      this.db,
      `INSERT INTO facts (id, created_at, updated_at, kind, key, text, tags, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      now,
      now,
      kind,
      key,
      text,
      JSON.stringify(tags),
      vec ? new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength) : null,
    );
    runStatement(this.db, `INSERT INTO facts_fts (id, text, tags) VALUES (?, ?, ?)`, id, text, tags.join(" "));
  }

  private async retext(row: Row, text: string, kind: string, tags: string[], now: string): Promise<void> {
    const mergedTags = [...new Set([...parseStringList(row["tags"]), ...tags])];
    const vec = this.embedder.configured ? await this.embedder.embed(text) : null;
    runStatement(
      this.db,
      `UPDATE facts SET text = ?, kind = ?, tags = ?, updated_at = ?, embedding = ? WHERE id = ?`,
      text,
      kind,
      JSON.stringify(mergedTags),
      now,
      vec ? new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength) : null,
      String(row["id"]),
    );
    runStatement(this.db, `DELETE FROM facts_fts WHERE id = ?`, String(row["id"]));
    runStatement(this.db, `INSERT INTO facts_fts (id, text, tags) VALUES (?, ?, ?)`, String(row["id"]), text, mergedTags.join(" "));
  }

  private nearest(queryVec: Float32Array): { id: string; score: number } | null {
    const rows = rowsOf(this.db, `SELECT id, embedding FROM facts WHERE embedding IS NOT NULL LIMIT 5000`);
    let best: { id: string; score: number } | null = null;
    for (const r of rows) {
      const vec = fromBlob(r["embedding"]);
      if (!vec) continue;
      const score = cosine(queryVec, vec);
      if (!best || score > best.score) best = { id: String(r["id"]), score };
    }
    return best;
  }

  async search(query: string, opts: { k?: number } = {}): Promise<FactHit[]> {
    const k = clamp(Math.round(opts.k ?? 5), 1, 25);
    const match = buildMatchQuery(query);
    const rows: Row[] = match
      ? rowsOf(
          this.db,
          `SELECT facts.*, bm25(facts_fts) AS rank FROM facts_fts
             JOIN facts ON facts.id = facts_fts.id
            WHERE facts_fts MATCH ? ORDER BY rank LIMIT 100`,
          match,
        )
      : rowsOf(this.db, `SELECT * FROM facts ORDER BY updated_at DESC LIMIT 100`);

    const relevances = new Map<string, number>();
    for (const r of rows) relevances.set(String(r["id"]), lexicalFromRank(r["rank"]));
    const lex = normalizeLexical(relevances);
    const qvec = this.embedder.configured ? await this.embedder.embed(query) : null;

    return rows
      .map((r) => {
        const id = String(r["id"]);
        const itemVec = qvec ? fromBlob(r["embedding"]) : null;
        return {
          fact: toFact(r),
          score: blendedScore(lex.get(id) ?? 0, qvec, itemVec, String(r["updated_at"])),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  forget(selector: { id?: string; key?: string; text?: string }): number {
    const conditions: string[] = [];
    const params: string[] = [];
    if (selector.id) {
      conditions.push("id = ?");
      params.push(selector.id);
    }
    if (selector.key) {
      conditions.push("key = ?");
      params.push(selector.key);
    }
    if (selector.text) {
      conditions.push("text = ?");
      params.push(selector.text);
    }
    if (conditions.length === 0) throw new Error("fact_forget needs one of: id, key, text");
    const rows = rowsOf(this.db, `SELECT id FROM facts WHERE ${conditions.join(" OR ")}`, ...params);
    for (const r of rows) {
      const id = String(r["id"]);
      runStatement(this.db, `DELETE FROM facts WHERE id = ?`, id);
      runStatement(this.db, `DELETE FROM facts_fts WHERE id = ?`, id);
    }
    return rows.length;
  }
}

function toFact(row: Row): Fact {
  return {
    id: String(row["id"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
    kind: String(row["kind"]),
    key: typeof row["key"] === "string" ? row["key"] : null,
    text: String(row["text"]),
    tags: parseStringList(row["tags"]),
  };
}

export function toFactInput(args: Record<string, unknown>): FactRememberInput {
  return {
    text: String(args["text"] ?? ""),
    ...(typeof args["kind"] === "string" ? { kind: args["kind"] } : {}),
    ...(Array.isArray(args["tags"]) ? { tags: stringArray(args["tags"]) } : {}),
    ...(typeof args["key"] === "string" ? { key: args["key"] } : {}),
  };
}
