import { insertEpisodeTrigram, rowOf, rowsOf, runStatement, type Db, type Row } from "./db.js";
import { fromBlob, type Embedder } from "./embed.js";
import { blendedScore, buildMatchQuery, lexicalFromRank, normalizeLexical } from "./search.js";
import { clamp, newId, nowIso, parseStringList, snippet, stringArray } from "./util.js";

export interface EpisodeInput {
  goal: string;
  outcome: string;
  summary: string;
  lessons?: string[];
  tools?: string[];
  artifacts?: string[];
  tags?: string[];
  project?: string;
  taskId?: string;
  durationMs?: number;
}

export interface Episode {
  id: string;
  createdAt: string;
  goal: string;
  outcome: string;
  summary: string;
  lessons: string[];
  tools: string[];
  artifacts: string[];
  tags: string[];
  project: string | null;
  taskId: string | null;
  durationMs: number | null;
}

export interface EpisodeHit {
  episode: Episode;
  score: number;
}

export interface EpisodeSearchOptions {
  k?: number;
  outcome?: string;
  tag?: string;
  since?: string;
}

const OUTCOMES = new Set(["success", "partial", "failed"]);

export class Episodes {
  constructor(
    private readonly db: Db,
    private readonly embedder: Embedder,
  ) {}

  async record(input: EpisodeInput): Promise<{ id: string; createdAt: string; deduped?: boolean }> {
    const goal = input.goal.trim();
    const summary = input.summary.trim();
    const outcome = input.outcome.trim().toLowerCase();
    if (!goal) throw new Error("episode_record requires a goal");
    if (!summary) throw new Error("episode_record requires a summary");
    if (!OUTCOMES.has(outcome)) throw new Error(`outcome must be one of: ${[...OUTCOMES].join(", ")}`);
    if (input.taskId) {
      const already = rowOf(this.db, `SELECT id, created_at FROM episodes WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`, input.taskId);
      if (already) return { id: String(already["id"]), createdAt: String(already["created_at"]), deduped: true };
    }
    const lessons = input.lessons ?? [];
    const tools = input.tools ?? [];
    const artifacts = input.artifacts ?? [];
    const tags = input.tags ?? [];
    const id = newId("ep");
    const createdAt = nowIso();
    const embedding = await this.embedder.embed([goal, summary, ...lessons].join("\n"));
    runStatement(
      this.db,
      `INSERT INTO episodes (id, created_at, goal, outcome, summary, lessons, tools, artifacts, tags, project, task_id, duration_ms, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      createdAt,
      goal,
      outcome,
      summary,
      JSON.stringify(lessons),
      JSON.stringify(tools),
      JSON.stringify(artifacts),
      JSON.stringify(tags),
      input.project ?? null,
      input.taskId ?? null,
      typeof input.durationMs === "number" ? Math.round(input.durationMs) : null,
      embedding ? new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength) : null,
    );
    runStatement(
      this.db,
      `INSERT INTO episodes_fts (id, goal, summary, lessons, tags) VALUES (?, ?, ?, ?, ?)`,
      id,
      goal,
      summary,
      lessons.join(" "),
      tags.join(" "),
    );
    insertEpisodeTrigram(this.db, {
      id,
      goal,
      summary,
      lessons: lessons.join(" "),
      tools: tools.join(" "),
      tags: tags.join(" "),
    });
    return { id, createdAt };
  }

  async search(query: string, opts: EpisodeSearchOptions = {}): Promise<EpisodeHit[]> {
    const k = clamp(Math.round(opts.k ?? 5), 1, 25);
    const match = buildMatchQuery(query);
    const rows: Row[] = match
      ? rowsOf(
          this.db,
          `SELECT episodes.*, bm25(episodes_fts) AS rank FROM episodes_fts
             JOIN episodes ON episodes.id = episodes_fts.id
            WHERE episodes_fts MATCH ? ORDER BY rank LIMIT 100`,
          match,
        )
      : rowsOf(this.db, `SELECT * FROM episodes ORDER BY created_at DESC LIMIT 100`);

    const tag = opts.tag?.toLowerCase();
    const filtered = rows.filter((r) => {
      if (opts.outcome && String(r["outcome"]) !== opts.outcome) return false;
      if (tag && !parseStringList(r["tags"]).some((t) => t.toLowerCase() === tag)) return false;
      if (opts.since) {
        const created = String(r["created_at"]);
        const key = opts.since.length === 10 ? created.slice(0, 10) : created;
        if (key < opts.since) return false;
      }
      return true;
    });

    const relevances = new Map<string, number>();
    for (const r of filtered) relevances.set(String(r["id"]), lexicalFromRank(r["rank"]));
    const lex = normalizeLexical(relevances);
    const qvec = this.embedder.configured ? await this.embedder.embed(query) : null;

    return filtered
      .map((r) => {
        const id = String(r["id"]);
        const itemVec = qvec ? fromBlob(r["embedding"]) : null;
        return {
          episode: toEpisode(r),
          score: blendedScore(lex.get(id) ?? 0, qvec, itemVec, String(r["created_at"])),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  get(id: string): Episode | null {
    const row = rowOf(this.db, `SELECT * FROM episodes WHERE id = ?`, id.trim());
    return row ? toEpisode(row) : null;
  }

  stats(): {
    total: number;
    last7d: number;
    byOutcome: Record<string, number>;
    topTags: Array<{ tag: string; count: number }>;
    topTools: Array<{ tool: string; count: number }>;
    latest: { id: string; createdAt: string; goal: string } | null;
  } {
    const one = (sql: string): number => {
      const row = rowOf(this.db, sql);
      return row ? Number(row["c"] ?? 0) : 0;
    };
    const total = one(`SELECT COUNT(*) AS c FROM episodes`);
    const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const last7d = one(`SELECT COUNT(*) AS c FROM episodes WHERE created_at >= '${cutoff}'`);
    const byOutcome: Record<string, number> = {};
    for (const r of rowsOf(this.db, `SELECT outcome, COUNT(*) AS c FROM episodes GROUP BY outcome`)) {
      byOutcome[String(r["outcome"])] = Number(r["c"] ?? 0);
    }
    const tagCounts = new Map<string, number>();
    const toolCounts = new Map<string, number>();
    for (const r of rowsOf(this.db, `SELECT tags, tools FROM episodes ORDER BY created_at DESC LIMIT 300`)) {
      for (const t of parseStringList(r["tags"])) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      for (const t of parseStringList(r["tools"])) toolCounts.set(t, (toolCounts.get(t) ?? 0) + 1);
    }
    const top = (m: Map<string, number>, n: number): Array<{ tag: string; count: number }> =>
      [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([tag, count]) => ({ tag, count }));
    const latestRow = rowOf(this.db, `SELECT id, created_at, goal FROM episodes ORDER BY created_at DESC LIMIT 1`);
    return {
      total,
      last7d,
      byOutcome,
      topTags: top(tagCounts, 8),
      topTools: top(toolCounts, 8).map((x) => ({ tool: x.tag, count: x.count })),
      latest: latestRow
        ? { id: String(latestRow["id"]), createdAt: String(latestRow["created_at"]), goal: snippet(String(latestRow["goal"]), 160) }
        : null,
    };
  }

  async embedMissing(limit = 50): Promise<number> {
    if (!this.embedder.configured) return 0;
    const rows = rowsOf(
      this.db,
      `SELECT id, goal, summary, lessons FROM episodes WHERE embedding IS NULL ORDER BY created_at DESC LIMIT ?`,
      limit,
    );
    let done = 0;
    for (const r of rows) {
      const vec = await this.embedder.embed(
        [String(r["goal"]), String(r["summary"]), parseStringList(r["lessons"]).join("\n")].join("\n"),
      );
      if (!vec) break;
      runStatement(
        this.db,
        `UPDATE episodes SET embedding = ? WHERE id = ?`,
        new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength),
        String(r["id"]),
      );
      done += 1;
    }
    return done;
  }
}

function toEpisode(row: Row): Episode {
  return {
    id: String(row["id"]),
    createdAt: String(row["created_at"]),
    goal: String(row["goal"]),
    outcome: String(row["outcome"]),
    summary: String(row["summary"]),
    lessons: parseStringList(row["lessons"]),
    tools: parseStringList(row["tools"]),
    artifacts: parseStringList(row["artifacts"]),
    tags: parseStringList(row["tags"]),
    project: typeof row["project"] === "string" ? row["project"] : null,
    taskId: typeof row["task_id"] === "string" ? row["task_id"] : null,
    durationMs: typeof row["duration_ms"] === "number" ? row["duration_ms"] : null,
  };
}

export function toEpisodeInput(args: Record<string, unknown>): EpisodeInput {
  return {
    goal: String(args["goal"] ?? ""),
    outcome: String(args["outcome"] ?? "success"),
    summary: String(args["summary"] ?? ""),
    lessons: stringArray(args["lessons"]),
    tools: stringArray(args["tools"]),
    artifacts: stringArray(args["artifacts"]),
    tags: stringArray(args["tags"]),
    ...(typeof args["project"] === "string" ? { project: args["project"] } : {}),
    ...(typeof args["task_id"] === "string" ? { taskId: args["task_id"] } : {}),
    ...(typeof args["duration_ms"] === "number" ? { durationMs: args["duration_ms"] } : {}),
  };
}
