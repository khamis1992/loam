import fs from "node:fs";
import path from "node:path";
import { rowOf, rowsOf, runStatement, type Db, type Row } from "./db.js";
import { fromBlob, type Embedder } from "./embed.js";
import { blendedScore, buildMatchQuery, lexicalFromRank, normalizeLexical } from "./search.js";
import {
  buildSkillFile,
  clamp,
  daysSince,
  envValue,
  newId,
  nowIso,
  parseFrontmatter,
  parseNotes,
  parseStringList,
  sha1,
  slugify,
  snippet,
  splitFrontmatter,
  type FailureNote,
} from "./util.js";

export interface SkillStats {
  uses: number;
  successes: number;
  failures: number;
  partials: number;
  successRate: number;
}

export interface SkillHit {
  slug: string;
  name: string;
  description: string;
  version: number;
  stats: SkillStats;
  lastUsed: string | null;
  updatedAt: string;
  tags: string[];
  score: number;
}

export interface SkillDetail {
  slug: string;
  name: string;
  description: string;
  version: number;
  path: string;
  source: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lastUsed: string | null;
  stats: SkillStats;
  pendingNotes: FailureNote[];
  history: string[];
  content: string;
}

export interface SkillRecordResult {
  slug: string;
  path: string;
  version: number;
  action: "created" | "updated";
}

export interface SkillReportResult {
  slug: string;
  name: string;
  stats: SkillStats;
  pendingNotes: number;
  hint: string;
}

export interface SkillImproveResult {
  changed: boolean;
  slug: string;
  version: number;
  consumedNotes: number;
  added: string[];
  message: string;
}

export interface ReviewItem {
  slug: string;
  name: string;
  priority: number;
  reasons: string[];
  uses: number;
  successes: number;
  failures: number;
  partials: number;
  updatedAt: string;
}

export interface ComposeResult {
  plan: string;
  usedSkills: Array<{ slug: string; name: string; stats: SkillStats }>;
  notes: string[];
}

const LESSONS_HEADING_RE = /^##\s+Lessons\s*(?:&|and)?\s*Fixes\s*$/i;
const PROCEDURE_HEADING_RE = /^(?:procedure|steps|how[\s-]?to|خطوات|الإجراء)/i;
const TOOL_TOKEN_RE = /\b(?:browser|browser_table|browser_act|memory|session|file|files|shell|pty|web|screen|computer|preview|skill|fact|episode|recall|mcp__)[a-z0-9_]*\b/g;

export class Skills {
  private lastSync = 0;

  constructor(
    private readonly db: Db,
    private readonly embedder: Embedder,
    private readonly skillsDir: string,
  ) {}

  async sync(force = false): Promise<{ indexed: number; removed: number }> {
    const now = Date.now();
    if (!force && now - this.lastSync < 1000) return { indexed: 0, removed: 0 };
    this.lastSync = now;
    fs.mkdirSync(this.skillsDir, { recursive: true });
    const seen = new Set<string>();
    let indexed = 0;
    let removed = 0;

    for (const entry of fs.readdirSync(this.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.skillsDir, entry.name);
      const file = path.join(dir, "SKILL.md");
      let raw = "";
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const slug = entry.name;
      seen.add(slug);
      const hash = sha1(raw);
      const fm = parseFrontmatter(raw);
      const name = (fm.name ?? slug).trim() || slug;
      const description = (fm.description ?? "").trim();
      const body = splitFrontmatter(raw).body;
      const existing = this.row(slug);
      if (!existing) {
        runStatement(
          this.db,
          `INSERT INTO skills (slug, name, description, path, version, created_at, updated_at, source, body, hash)
           VALUES (?, ?, ?, ?, 1, ?, ?, 'disk', ?, ?)`,
          slug,
          name,
          description,
          file,
          nowIso(),
          nowIso(),
          body,
          hash,
        );
        this.ftsReplace(slug, name, description, body, "[]");
        await this.embedRow(slug, name, description, body);
        indexed += 1;
      } else if (String(existing["hash"]) !== hash || String(existing["name"]) !== name || String(existing["description"]) !== description) {
        runStatement(
          this.db,
          `UPDATE skills SET name = ?, description = ?, path = ?, body = ?, hash = ?, updated_at = ? WHERE slug = ?`,
          name,
          description,
          file,
          body,
          hash,
          nowIso(),
          slug,
        );
        this.ftsReplace(slug, name, description, body, String(existing["tags"] ?? "[]"));
        await this.embedRow(slug, name, description, body);
        indexed += 1;
      } else if (String(existing["path"]) !== file) {
        runStatement(this.db, `UPDATE skills SET path = ? WHERE slug = ?`, file, slug);
      }
    }

    for (const r of rowsOf(this.db, `SELECT slug FROM skills`)) {
      const slug = String(r["slug"]);
      if (seen.has(slug)) continue;
      runStatement(this.db, `DELETE FROM skills WHERE slug = ?`, slug);
      runStatement(this.db, `DELETE FROM skills_fts WHERE slug = ?`, slug);
      removed += 1;
    }
    return { indexed, removed };
  }

  async record(input: {
    name: string;
    description: string;
    body: string;
    tags?: string[];
    source?: string;
  }): Promise<SkillRecordResult> {
    await this.sync();
    const name = input.name.trim();
    const body = input.body.trim();
    if (!name) throw new Error("skill_record requires a name");
    if (!body) throw new Error("skill_record requires a body");
    const description = input.description.trim();
    const slug = slugify(name);
    const dir = path.join(this.skillsDir, slug);
    const file = path.join(dir, "SKILL.md");
    fs.mkdirSync(dir, { recursive: true });

    let version = 1;
    let action: SkillRecordResult["action"] = "created";
    const row = this.row(slug);
    if (fs.existsSync(file)) {
      const oldRaw = fs.readFileSync(file, "utf8");
      const oldVersion = row ? Number(row["version"] ?? 1) : 1;
      this.writeHistory(dir, oldRaw, oldVersion);
      version = oldVersion + 1;
      action = "updated";
    }

    const content = buildSkillFile(name, description, body);
    fs.writeFileSync(file, content, "utf8");
    const now = nowIso();
    const source = input.source ?? "agent";
    const tags = input.tags ?? [];
    if (row) {
      const mergedTags = [...new Set([...parseStringList(row["tags"]), ...tags])];
      runStatement(
        this.db,
        `UPDATE skills SET name = ?, description = ?, path = ?, body = ?, hash = ?, version = ?, updated_at = ?, source = ?, tags = ? WHERE slug = ?`,
        name,
        description,
        file,
        body,
        sha1(content),
        version,
        now,
        source,
        JSON.stringify(mergedTags),
        slug,
      );
      this.ftsReplace(slug, name, description, body, JSON.stringify(mergedTags));
    } else {
      runStatement(
        this.db,
        `INSERT INTO skills (slug, name, description, path, version, created_at, updated_at, source, tags, body, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        slug,
        name,
        description,
        file,
        version,
        now,
        now,
        source,
        JSON.stringify(tags),
        body,
        sha1(content),
      );
      this.ftsReplace(slug, name, description, body, JSON.stringify(tags));
    }
    await this.embedRow(slug, name, description, body);
    return { slug, path: file, version, action };
  }

  async search(query: string, opts: { k?: number } = {}): Promise<SkillHit[]> {
    await this.sync();
    const k = clamp(Math.round(opts.k ?? 5), 1, 30);
    const match = buildMatchQuery(query);
    const rows: Row[] = match
      ? rowsOf(
          this.db,
          `SELECT skills.*, bm25(skills_fts) AS rank FROM skills_fts
             JOIN skills ON skills.slug = skills_fts.slug
            WHERE skills_fts MATCH ? ORDER BY rank LIMIT 60`,
          match,
        )
      : rowsOf(this.db, `SELECT * FROM skills ORDER BY updated_at DESC LIMIT 60`);

    const relevances = new Map<string, number>();
    for (const r of rows) relevances.set(String(r["slug"]), lexicalFromRank(r["rank"]));
    const lex = normalizeLexical(relevances);
    const qvec = this.embedder.configured && query.trim().length > 0 ? await this.embedder.embed(query) : null;

    return rows
      .map((r) => {
        const slug = String(r["slug"]);
        const stats = statsOf(r);
        const prior = 0.6 + 0.4 * ((stats.successes + 0.5 * stats.partials + 1) / (stats.uses + 2));
        const itemVec = qvec ? fromBlob(r["embedding"]) : null;
        return {
          slug,
          name: String(r["name"]),
          description: String(r["description"]),
          version: Number(r["version"] ?? 1),
          stats,
          lastUsed: typeof r["last_used"] === "string" ? r["last_used"] : null,
          updatedAt: String(r["updated_at"]),
          tags: parseStringList(r["tags"]),
          score: blendedScore(lex.get(slug) ?? 0, qvec, itemVec, String(r["updated_at"])) * prior,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  async get(name: string): Promise<SkillDetail | null> {
    await this.sync();
    const row = this.find(name);
    if (!row) return null;
    const file = String(row["path"]);
    let content = "";
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      content = "";
    }
    return {
      slug: String(row["slug"]),
      name: String(row["name"]),
      description: String(row["description"]),
      version: Number(row["version"] ?? 1),
      path: file,
      source: String(row["source"] ?? "disk"),
      tags: parseStringList(row["tags"]),
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
      lastUsed: typeof row["last_used"] === "string" ? row["last_used"] : null,
      stats: statsOf(row),
      pendingNotes: parseNotes(row["failure_notes"]),
      history: listHistory(path.dirname(file)),
      content,
    };
  }

  async report(
    name: string,
    outcome: "success" | "failure" | "partial",
    notes?: string,
    durationMs?: number,
  ): Promise<SkillReportResult> {
    await this.sync();
    const row = this.find(name);
    if (!row) throw new Error(`skill not found: ${name}`);
    const slug = String(row["slug"]);
    const now = nowIso();
    const pending = parseNotes(row["failure_notes"]);
    if (typeof notes === "string" && notes.trim().length > 0) {
      pending.push({ at: now, outcome, note: notes.trim().slice(0, 1000) });
      while (pending.length > 20) pending.shift();
    }
    runStatement(
      this.db,
      `UPDATE skills SET uses = uses + 1,
         successes = successes + ?, failures = failures + ?, partials = partials + ?,
         last_used = ?, failure_notes = ? WHERE slug = ?`,
      outcome === "success" ? 1 : 0,
      outcome === "failure" ? 1 : 0,
      outcome === "partial" ? 1 : 0,
      now,
      JSON.stringify(pending),
      slug,
    );
    const updated = this.row(slug)!;
    const stats = statsOf(updated);
    const unreviewed = parseNotes(updated["failure_notes"]).length;
    const hint =
      unreviewed > 0
        ? `call skill_improve("${slug}") to fold ${unreviewed} outcome note(s) into the skill`
        : outcome === "success"
          ? "recorded"
          : "recorded (no note kept — pass notes to help the next run)";
    void durationMs;
    return { slug, name: String(updated["name"]), stats, pendingNotes: unreviewed, hint };
  }

  async improve(name: string, lessons?: string[]): Promise<SkillImproveResult> {
    await this.sync();
    const row = this.find(name);
    if (!row) throw new Error(`skill not found: ${name}`);
    const slug = String(row["slug"]);
    const version = Number(row["version"] ?? 1);
    const pending = parseNotes(row["failure_notes"]);
    const provided = (lessons ?? []).map((l) => l.trim()).filter((l) => l.length > 0);
    const bullets = [...provided, ...pending.map((n) => n.note)];
    if (bullets.length === 0) {
      return { changed: false, slug, version, consumedNotes: 0, added: [], message: "nothing to improve: no failure notes and no lessons provided" };
    }
    const file = String(row["path"]);
    const raw = fs.readFileSync(file, "utf8");
    const fm = parseFrontmatter(raw);
    const body = splitFrontmatter(raw).body;
    const { merged, added } = mergeLessons(body, bullets, 12);
    if (added.length === 0) {
      runStatement(this.db, `UPDATE skills SET failure_notes = '[]' WHERE slug = ?`, slug);
      return { changed: false, slug, version, consumedNotes: pending.length, added: [], message: "all notes were already present in the skill" };
    }
    const dir = path.dirname(file);
    this.writeHistory(dir, raw, version);
    const content = buildSkillFile(fm.name ?? String(row["name"]), fm.description ?? String(row["description"]), merged);
    fs.writeFileSync(file, content, "utf8");
    const newVersion = version + 1;
    runStatement(
      this.db,
      `UPDATE skills SET body = ?, hash = ?, version = ?, updated_at = ?, failure_notes = '[]' WHERE slug = ?`,
      merged,
      sha1(content),
      newVersion,
      nowIso(),
      slug,
    );
    this.ftsReplace(slug, String(row["name"]), String(row["description"]), merged, String(row["tags"] ?? "[]"));
    await this.embedRow(slug, String(row["name"]), String(row["description"]), merged);
    return {
      changed: true,
      slug,
      version: newVersion,
      consumedNotes: pending.length,
      added,
      message: `bumped to v${newVersion}: ${added.length} lesson(s) merged; previous revision kept in history/`,
    };
  }

  async review(opts: { limit?: number } = {}): Promise<ReviewItem[]> {
    await this.sync();
    const limit = clamp(Math.round(opts.limit ?? 20), 1, 100);
    const items: ReviewItem[] = [];
    for (const row of rowsOf(this.db, `SELECT * FROM skills`)) {
      const slug = String(row["slug"]);
      const uses = Number(row["uses"] ?? 0);
      const successes = Number(row["successes"] ?? 0);
      const failures = Number(row["failures"] ?? 0);
      const partials = Number(row["partials"] ?? 0);
      const rate = uses > 0 ? (successes + 0.5 * partials) / uses : 0;
      const pending = parseNotes(row["failure_notes"]).length;
      const created = String(row["created_at"]);
      const lastUsed = typeof row["last_used"] === "string" ? row["last_used"] : null;
      const reasons: string[] = [];
      let priority = 0;
      if (pending > 0) {
        reasons.push(`${pending} unreviewed outcome note(s) — call skill_improve`);
        priority = Math.max(priority, 3);
      }
      if (uses >= 3 && rate < 0.6) {
        reasons.push(`low success rate ${Math.round(rate * 100)}% over ${uses} use(s)`);
        priority = Math.max(priority, 2);
      }
      if (uses === 0 && daysSince(created) >= 30) {
        reasons.push(`never used in ${daysSince(created)} day(s) — sharpen the description or delete`);
        priority = Math.max(priority, 1);
      }
      if (uses > 0 && lastUsed && daysSince(lastUsed) >= 60) {
        reasons.push(`stale: last used ${daysSince(lastUsed)} day(s) ago`);
        priority = Math.max(priority, 1);
      }
      if (priority > 0) {
        items.push({ slug, name: String(row["name"]), priority, reasons, uses, successes, failures, partials, updatedAt: String(row["updated_at"]) });
      }
    }
    return items.sort((a, b) => b.priority - a.priority || b.uses - a.uses).slice(0, limit);
  }

  async compose(goal: string, opts: { skills?: string[]; k?: number; availableTools?: string[] } = {}): Promise<ComposeResult> {
    await this.sync();
    const trimmedGoal = goal.trim();
    if (!trimmedGoal) throw new Error("skill_compose requires a goal");
    const chosen: Row[] = [];
    if (opts.skills && opts.skills.length > 0) {
      for (const s of opts.skills) {
        const row = this.find(s);
        if (!row) throw new Error(`skill not found: ${s}`);
        chosen.push(row);
      }
    } else {
      const hits = await this.search(trimmedGoal, { k: opts.k ?? 3 });
      for (const hit of hits) {
        const row = this.row(hit.slug);
        if (row) chosen.push(row);
      }
    }

    const notes: string[] = [];
    if (chosen.length === 0) {
      return { plan: `(no matching skills for: ${trimmedGoal})`, usedSkills: [], notes: ["record a skill with skill_record or install one first"] };
    }

    const steps: Array<{ text: string; source: string }> = [];
    const seenSteps = new Set<string>();
    const toolTokens = new Set<string>();
    const usedSkills: ComposeResult["usedSkills"] = [];

    for (const row of chosen) {
      const file = String(row["path"]);
      let content = "";
      try {
        content = fs.readFileSync(file, "utf8");
      } catch {
        notes.push(`could not read skill "${row["slug"]}" (${file})`);
        continue;
      }
      const slug = String(row["slug"]);
      const body = splitFrontmatter(content).body;
      usedSkills.push({ slug, name: String(row["name"]), stats: statsOf(row) });
      const skillSteps = extractProcedureSteps(body);
      if (skillSteps.length === 0) {
        notes.push(`skill "${slug}" has no numbered steps — add a "## Procedure" section so it can compose`);
      }
      for (const s of skillSteps) {
        const key = s.toLowerCase().replace(/\s+/g, " ").trim();
        if (seenSteps.has(key)) continue;
        seenSteps.add(key);
        steps.push({ text: s, source: slug });
      }
      for (const m of content.matchAll(TOOL_TOKEN_RE)) toolTokens.add(m[0]);
    }

    if (opts.availableTools && opts.availableTools.length > 0 && toolTokens.size > 0) {
      const available = new Set(opts.availableTools);
      const missing = [...toolTokens].filter((t) => !available.has(t));
      if (missing.length > 0) notes.push(`verify tool availability (not in available_tools): ${missing.slice(0, 10).join(", ")}`);
    }

    const lines: string[] = [];
    lines.push(`## Plan: ${trimmedGoal}`);
    steps.forEach((s, i) => lines.push(`${i + 1}. ${s.text}  ← ${s.source}`));
    lines.push("");
    lines.push("## Skills reused");
    for (const s of usedSkills) {
      const rate = s.stats.uses > 0 ? `${Math.round(s.stats.successRate * 100)}% success over ${s.stats.uses} use(s)` : "untried";
      lines.push(`- ${s.slug}: ${rate}`);
    }
    if (notes.length > 0) {
      lines.push("");
      lines.push("## Notes");
      for (const n of notes) lines.push(`- ${n}`);
    }
    return { plan: lines.join("\n"), usedSkills, notes };
  }

  async fromTrace(input: { tracePath?: string; steps?: string[]; name?: string; description?: string }): Promise<SkillRecordResult & { capturedSteps: number; draftPreview: string }> {
    let steps: string[] = (input.steps ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
    let sourceName = input.name?.trim() ?? "";
    let finalUrl = "";
    let failedActions = 0;

    if (steps.length === 0) {
      const file = resolveTracePath(input.tracePath);
      const raw = fs.readFileSync(file, "utf8");
      if (raw.length > 4_000_000) throw new Error("trace file too large (max 4 MB)");
      const data = JSON.parse(raw) as unknown;
      const obj = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
      const actions = Array.isArray(data) ? (data as unknown[]) : Array.isArray(obj?.["actions"]) ? (obj!["actions"] as unknown[]) : null;
      if (!actions) throw new Error("trace JSON has no actions array");
      if (!sourceName && typeof obj?.["name"] === "string") sourceName = obj["name"];
      if (!sourceName) sourceName = path.basename(file).replace(/\.json$/i, "");
      for (const rawAction of actions) {
        const a = rawAction && typeof rawAction === "object" ? (rawAction as Record<string, unknown>) : {};
        const step = actionToStep(a);
        if (!step) continue;
        steps.push(step);
        const url = typeof a["url"] === "string" ? a["url"] : "";
        if (url) finalUrl = url;
        if (a["ok"] === false) failedActions += 1;
      }
    }

    if (steps.length === 0) throw new Error("no steps found in the recording");
    const name = input.name?.trim() || sourceName || `trace-${newId("s").slice(2)}`;
    const description =
      input.description?.trim() || `Replay of a recorded browser workflow${sourceName ? ` "${sourceName}"` : ""}; use when the same site/flow is needed.`;
    const pitfalls = [
      "- Element indexes go stale after every action: re-observe with browser_table before each step (never guess indexes).",
      ...(failedActions > 0 ? [`- ${failedActions} recorded action(s) failed; the fix is not in this draft — verify those steps manually.`] : []),
    ];
    const body = [
      "## When to Use",
      `Draft captured from a browser recording${sourceName ? ` ("${sourceName}")` : ""}. Use when repeating this exact flow; review the steps before relying on them.`,
      "",
      "## Procedure",
      ...steps.map((s, i) => `${i + 1}. ${s}`),
      "",
      "## Pitfalls",
      ...pitfalls,
      "",
      "## Verification",
      finalUrl ? `- Confirm the final page matches the recorded end state: ${finalUrl}` : "- Confirm the workflow ends in the expected application state.",
    ].join("\n");

    const res = await this.record({ name, description, body, tags: ["from-trace", "browser"], source: "trace" });
    return { ...res, capturedSteps: steps.length, draftPreview: snippet(body, 400) };
  }

  private row(slug: string): Row | null {
    return rowOf(this.db, `SELECT * FROM skills WHERE slug = ?`, slug);
  }

  private find(nameOrSlug: string): Row | null {
    const q = nameOrSlug.trim();
    if (!q) return null;
    return this.row(slugify(q)) ?? this.row(q.toLowerCase()) ?? this.findByName(q);
  }

  private findByName(name: string): Row | null {
    const lower = name.toLowerCase();
    for (const r of rowsOf(this.db, `SELECT * FROM skills`)) {
      if (String(r["name"]).toLowerCase() === lower || String(r["slug"]).toLowerCase() === lower) return r;
    }
    return null;
  }

  private ftsReplace(slug: string, name: string, description: string, body: string, tagsJson: string): void {
    runStatement(this.db, `DELETE FROM skills_fts WHERE slug = ?`, slug);
    runStatement(
      this.db,
      `INSERT INTO skills_fts (slug, name, description, body, tags) VALUES (?, ?, ?, ?, ?)`,
      slug,
      name,
      description,
      body,
      parseStringList(tagsJson).join(" "),
    );
  }

  private async embedRow(slug: string, name: string, description: string, body: string): Promise<void> {
    if (!this.embedder.configured) return;
    const vec = await this.embedder.embed(`${name}\n${description}\n${body.slice(0, 2500)}`);
    if (!vec) return;
    runStatement(
      this.db,
      `UPDATE skills SET embedding = ? WHERE slug = ?`,
      new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength),
      slug,
    );
  }

  private writeHistory(dir: string, content: string, version: number): void {
    try {
      const historyDir = path.join(dir, "history");
      fs.mkdirSync(historyDir, { recursive: true });
      const stamp = nowIso().replace(/[:.]/g, "-");
      fs.writeFileSync(path.join(historyDir, `v${version}_${stamp}.md`), content, "utf8");
    } catch {
      /* history is best-effort */
    }
  }
}

function statsOf(row: Row): SkillStats {
  const uses = Number(row["uses"] ?? 0);
  const successes = Number(row["successes"] ?? 0);
  const failures = Number(row["failures"] ?? 0);
  const partials = Number(row["partials"] ?? 0);
  return {
    uses,
    successes,
    failures,
    partials,
    successRate: uses > 0 ? (successes + 0.5 * partials) / uses : 0,
  };
}

function listHistory(dir: string): string[] {
  try {
    return fs
      .readdirSync(path.join(dir, "history"))
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function resolveTracePath(tracePath?: string): string {
  const p = tracePath?.trim();
  if (!p) throw new Error("skill_from_trace needs trace_path (a recorded trace JSON) or inline steps");
  if (path.isAbsolute(p) && fs.existsSync(p)) return p;
  const workspace = envValue("MEMSKILLS_WORKSPACE") ?? process.cwd();
  const candidates = [path.join(workspace, p), path.join(workspace, ".browser-recordings", p)];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`trace file not found: ${p} (looked in ${workspace})`);
}

function actionToStep(a: Record<string, unknown>): string {
  const op = String(a["op"] ?? "").toUpperCase();
  if (!op) return "";
  let text = op;
  const url = typeof a["url"] === "string" ? a["url"] : "";
  if (op === "GOTO" || op === "NAVIGATE") {
    if (url) text += ` ${shortUrl(url)}`;
  } else {
    if (op === "TYPE_TEXT" && typeof a["text"] === "string") text += ` "${snippet(a["text"], 60)}"`;
    if (typeof a["index"] === "number") text += ` on element #${a["index"]}`;
    if (typeof a["text"] === "string" && op !== "TYPE_TEXT") text += ` "${snippet(a["text"], 60)}"`;
  }
  if (a["ok"] === false) {
    const message = typeof a["message"] === "string" ? a["message"] : "action failed";
    text += ` — FAILED: ${snippet(message, 80)}`;
  }
  return text;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return snippet(url, 80);
  }
}

function extractProcedureSteps(body: string): string[] {
  const lines = body.split(/\r?\n/);
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,4})\s+(.+)$/.exec(lines[i]!.trim());
    if (m && PROCEDURE_HEADING_RE.test(m[2]!.trim())) {
      start = i;
      level = m[1]!.length;
      break;
    }
  }
  const scope =
    start >= 0
      ? lines.slice(
          start + 1,
          (() => {
            for (let j = start + 1; j < lines.length; j++) {
              const m = /^(#{1,4})\s+\S/.exec(lines[j]!.trim());
              if (m && m[1]!.length <= level) return j;
            }
            return lines.length;
          })(),
        )
      : lines;
  const collect = (ls: string[]): string[] => {
    const out: string[] = [];
    for (const line of ls) {
      const m = /^\s*(?:\d+[.)]|[-*•])\s+(.+?)\s*$/.exec(line);
      if (m && m[1]) out.push(m[1].trim());
    }
    return out;
  };
  const steps = collect(scope);
  if (steps.length > 0) return steps.slice(0, 20);
  return collect(lines).slice(0, 12);
}

function normalizeBullet(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[-*•]\s+/, "")
    .trim();
}

function mergeLessons(body: string, bullets: string[], cap: number): { merged: string; added: string[] } {
  const lines = body.split(/\r?\n/);
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (LESSONS_HEADING_RE.test(lines[i]!.trim())) {
      start = i;
      break;
    }
  }
  const existing: string[] = [];
  if (start >= 0) {
    for (let j = start + 1; j < lines.length; j++) {
      if (/^#{1,2}\s+\S/.test(lines[j]!.trim())) {
        end = j;
        break;
      }
    }
    if (end < 0) end = lines.length;
    for (let j = start + 1; j < end; j++) {
      const m = /^\s*[-*•]\s+(.+)$/.exec(lines[j]!);
      if (m && m[1]) existing.push(m[1].trim());
    }
  }
  const seen = new Set(existing.map(normalizeBullet));
  const added: string[] = [];
  for (const b of bullets) {
    if (existing.length + added.length >= cap) break;
    const t = b.trim().replace(/^[-*•]\s+/, "");
    if (!t) continue;
    const key = normalizeBullet(t);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(t);
  }
  const mergedList = [...added, ...existing].slice(0, cap);
  const section = ["## Lessons & Fixes", ...mergedList.map((b) => `- ${b}`)].join("\n");
  let merged: string;
  if (start >= 0) {
    merged = [...lines.slice(0, start), ...section.split("\n"), ...(end < lines.length ? [""] : []), ...lines.slice(end)].join("\n");
  } else {
    let verificationIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s+Verification\s*$/i.test(lines[i]!.trim())) {
        verificationIndex = i;
        break;
      }
    }
    merged =
      verificationIndex >= 0
        ? [...lines.slice(0, verificationIndex), ...section.split("\n"), "", ...lines.slice(verificationIndex)].join("\n")
        : `${body.trimEnd()}\n\n${section}\n`;
  }
  return { merged: merged.trim(), added };
}
