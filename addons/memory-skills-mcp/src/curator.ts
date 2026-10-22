import { rowOf, rowsOf, runStatement, type Db, type Row } from "./db.js";
import { nowIso, parseStringList, slugify } from "./util.js";

/** Minimal structural contract the curator needs to apply a proposed skill. */
export interface SkillWriter {
  record(input: {
    name: string;
    description: string;
    body: string;
    tags?: string[];
    source?: string;
  }): Promise<{ slug: string; path: string; version: number; action: string }>;
}

export interface CuratorConfig {
  /** Days without use before an active skill becomes stale. */
  staleDays: number;
  /** Days without use before a stale skill is archived (never deleted). */
  archivedDays: number;
  /** The system counts as idle after this many hours without activity. */
  inactivityIdleHours: number;
  /** Minimum days between inactivity-driven curator runs. */
  inactivityLastRunDays: number;
  /** Successful tasks need at least this many tool calls before proposing a skill. */
  minToolCallsForProposal: number;
  /** Optional LLM consolidation pass over stale skills. Off by default. */
  consolidate: boolean;
  /** Optional model override for the consolidation pass. */
  consolidateModel?: string;
}

export const DEFAULT_CURATOR_CONFIG: CuratorConfig = {
  staleDays: 14,
  archivedDays: 30,
  inactivityIdleHours: 2,
  inactivityLastRunDays: 7,
  minToolCallsForProposal: 5,
  consolidate: false,
};

export interface CuratorDeps {
  /** Applied when `writeApproval` is false; when omitted, proposals are refused. */
  skills?: SkillWriter;
  /** Injectable clock (tests pass a fake). Defaults to the wall clock. */
  clock?: () => Date;
  /** Extra skill slugs referenced by scheduled jobs (exempt from lifecycle). */
  exemptScheduledSlugs?: () => Iterable<string>;
  /** Optional LLM used only when `config.consolidate` is true. */
  llm?: (prompt: string) => Promise<string>;
}

export type LifecycleState = "active" | "stale" | "archived";

export interface LifecycleResult {
  updated: number;
  skipped: number;
  states: Record<LifecycleState, number>;
}

export interface ProposeInput {
  /** Trace JSON (an array of actions or `{ actions: [...] }`) or inline `steps`. */
  trace?: unknown;
  /** Inline ordered steps (alternative to `trace`). */
  steps?: string[];
  /** Optional skill name override. */
  name?: string;
  /** Optional "when to use" line override. */
  description?: string;
  /** Number of tool calls in the finished task. */
  toolCallCount: number;
  /** Only successful tasks propose skills. Defaults to "success". */
  outcome?: string;
  /** Extra tags for the proposed skill. */
  tags?: string[];
}

export interface ProposeResult {
  proposed: boolean;
  staged: boolean;
  slug?: string;
  message: string;
}

export interface StagedSkill {
  slug: string;
  name: string;
  description: string;
  body: string;
  createdAt: string;
  toolCalls: number;
}

const META_LAST_RUN = "curator_last_run";
const META_LAST_ACTIVITY = "curator_last_activity";

/**
 * Skill curator: keeps the procedural library honest without ever destroying
 * knowledge. Skills move active -> stale -> archived (recoverable), pinned or
 * scheduled-job skills are exempt, and the whole pass is gated behind an
 * inactivity trigger so it only runs when the system has been quiet.
 */
export class Curator {
  private readonly clock: () => Date;
  private readonly config: CuratorConfig;
  private readonly deps: CuratorDeps;

  private readonly db: Db;

  constructor(db: Db, config: CuratorConfig = DEFAULT_CURATOR_CONFIG, deps: CuratorDeps = {}) {
    this.db = db;
    this.config = { ...DEFAULT_CURATOR_CONFIG, ...config };
    this.deps = deps;
    this.clock = deps.clock ?? (() => new Date());
  }

  now(): Date {
    return this.clock();
  }

  /** True when the skill must not be lifecycle-managed. */
  private isExempt(row: Row): boolean {
    if (Number(row["pinned"] ?? 0) === 1) return true;
    const tags = parseStringList(row["tags"]);
    if (tags.includes("pinned") || tags.includes("scheduled-job")) return true;
    const scheduled = this.deps.exemptScheduledSlugs?.();
    if (scheduled) {
      const set = new Set<string>();
      for (const s of scheduled) set.add(s.trim().toLowerCase());
      if (set.has(String(row["slug"]).toLowerCase())) return true;
    }
    return false;
  }

  /** Apply the lifecycle to every skill. Never deletes a row. */
  runLifecycle(now: Date = this.now()): LifecycleResult {
    const rows = rowsOf(
      this.db,
      `SELECT slug, pinned, tags, last_used, last_read_at, created_at FROM skills`,
    );
    const states: Record<LifecycleState, number> = { active: 0, stale: 0, archived: 0 };
    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
      const slug = String(row["slug"]);
      if (this.isExempt(row)) {
        skipped += 1;
        continue;
      }
      const state = lifecycleStateFor(row, this.config, now);
      states[state] += 1;
      runStatement(this.db, `UPDATE skills SET lifecycle_state = ? WHERE slug = ?`, state, slug);
      updated += 1;
    }

    this.persistMeta(META_LAST_RUN, isoOf(now));
    return { updated, skipped, states };
  }

  /**
   * Inactivity trigger: run only when the system has been idle for
   * `inactivityIdleHours` AND the previous run is older than
   * `inactivityLastRunDays`. Both gates are configurable; `idleMs`/`now` can be
   * injected for deterministic tests.
   */
  shouldRun(opts: { idleMs?: number; now?: Date } = {}): boolean {
    const now = opts.now ?? this.now();
    const lastActivity = this.lastActivityAt(now);
    const idleMs = opts.idleMs ?? (lastActivity !== null ? now.getTime() - lastActivity : Number.POSITIVE_INFINITY);
    if (idleMs < this.config.inactivityIdleHours * 3_600_000) return false;

    const lastRun = this.readMetaDate(META_LAST_RUN);
    if (lastRun === null) return true;
    return (now.getTime() - lastRun.getTime()) / 86_400_000 >= this.config.inactivityLastRunDays;
  }

  /** Run the lifecycle only when the inactivity trigger fires. */
  async maybeRun(opts: { idleMs?: number; now?: Date } = {}): Promise<{ ran: boolean; result?: LifecycleResult }> {
    if (!this.shouldRun(opts)) return { ran: false };
    const now = opts.now ?? this.now();
    return { ran: true, result: this.runLifecycle(now) };
  }

  /** Persist the last inactivity-check timestamp. */
  recordInactivityCheckRun(now: Date = this.now()): void {
    this.persistMeta(META_LAST_RUN, isoOf(now));
  }

  /** Record observed activity so the idle clock resets. */
  touchActivity(now: Date = this.now()): void {
    this.persistMeta(META_LAST_ACTIVITY, isoOf(now));
  }

  /**
   * Self-made skills loop: after a successful task with at least
   * `minToolCallsForProposal` tool calls, turn the trace into a proposed skill.
   * With `writeApproval` it is staged for a human; otherwise it is applied
   * through the injected skill writer.
   */
  async proposeSkill(input: ProposeInput, opts: { writeApproval: boolean }): Promise<ProposeResult> {
    const outcome = (input.outcome ?? "success").trim().toLowerCase();
    if (outcome && outcome !== "success") {
      return { proposed: false, staged: false, message: `task outcome is "${outcome}"; only successful tasks propose skills` };
    }
    if (input.toolCallCount < this.config.minToolCallsForProposal) {
      return {
        proposed: false,
        staged: false,
        message: `tool call count ${input.toolCallCount} below threshold ${this.config.minToolCallsForProposal}`,
      };
    }

    const steps = extractSteps(input);
    if (steps.length === 0) {
      return { proposed: false, staged: false, message: "no steps found in the trace" };
    }

    const name = input.name?.trim() || deriveName(input, steps);
    const description =
      input.description?.trim() ||
      `Use when repeating a ${steps.length}-step workflow similar to "${goalOf(input) ?? "the captured task"}".`;
    const body = buildProposedBody(name, description, steps);
    const slug = slugify(name) || `auto-${steps.length}-step`;

    if (opts.writeApproval) {
      runStatement(
        this.db,
        `INSERT INTO skill_staging (slug, name, description, body, created_at, tool_calls)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           body = excluded.body,
           created_at = excluded.created_at,
           tool_calls = excluded.tool_calls`,
        slug,
        name,
        description,
        body,
        nowIso(),
        input.toolCallCount,
      );
      return { proposed: true, staged: true, slug, message: `staged skill "${slug}" for approval` };
    }

    if (!this.deps.skills) {
      return { proposed: false, staged: false, message: "writeApproval is false but no skill writer is configured" };
    }
    const res = await this.deps.skills.record({
      name,
      description,
      body,
      tags: [...(input.tags ?? []), "auto", "from-trace"],
      source: "trace",
    });
    return { proposed: true, staged: false, slug: res.slug, message: `applied skill "${res.slug}"` };
  }

  /** Back-compat alias matching the earlier call shape. */
  proposeSkillFromTrace(
    trace: unknown,
    toolCallCount: number,
    opts: { writeApproval: boolean | "stage" | "apply" },
  ): Promise<ProposeResult> {
    const writeApproval = opts.writeApproval === true || opts.writeApproval === "stage";
    return this.proposeSkill({ trace, toolCallCount }, { writeApproval });
  }

  listStaged(): StagedSkill[] {
    const rows = rowsOf(this.db, `SELECT slug, name, description, body, created_at, tool_calls FROM skill_staging ORDER BY created_at DESC`);
    return rows.map((r) => ({
      slug: String(r["slug"]),
      name: String(r["name"]),
      description: String(r["description"]),
      body: String(r["body"]),
      createdAt: String(r["created_at"]),
      toolCalls: Number(r["tool_calls"] ?? 0),
    }));
  }

  async applyStaged(slug: string): Promise<{ applied: boolean; message: string }> {
    const row = rowOf(this.db, `SELECT * FROM skill_staging WHERE slug = ?`, slug);
    if (!row) return { applied: false, message: `no staged skill "${slug}"` };
    if (!this.deps.skills) {
      return { applied: false, message: "no skill writer configured; refusing to drop the staged draft" };
    }
    await this.deps.skills.record({
      name: String(row["name"]),
      description: String(row["description"]),
      body: String(row["body"]),
      tags: ["auto", "from-trace"],
      source: "trace",
    });
    runStatement(this.db, `DELETE FROM skill_staging WHERE slug = ?`, slug);
    return { applied: true, message: `applied staged skill "${slug}"` };
  }

  discardStaged(slug: string): boolean {
    const before = rowOf(this.db, `SELECT 1 AS ok FROM skill_staging WHERE slug = ?`, slug);
    if (!before) return false;
    runStatement(this.db, `DELETE FROM skill_staging WHERE slug = ?`, slug);
    return true;
  }

  /**
   * Optional LLM consolidation pass over stale skills. Disabled by default and
   * a pure stub: it plans the merge without touching skills unless an LLM is
   * injected and the flag is on.
   */
  async consolidate(opts: { now?: Date } = {}): Promise<{ run: boolean; planned: number; message: string }> {
    if (!this.config.consolidate) {
      return { run: false, planned: 0, message: "LLM consolidation disabled (curator.consolidate=false)" };
    }
    const stale = rowsOf(
      this.db,
      `SELECT slug, name, description, tags FROM skills WHERE lifecycle_state = 'stale' ORDER BY updated_at ASC`,
    );
    if (stale.length === 0) return { run: true, planned: 0, message: "no stale skills to consolidate" };
    const prompt = [
      "Consolidate stale skills by merging overlapping procedures.",
      ...stale.map((s) => `- ${String(s["slug"])}: ${String(s["description"] ?? "")}`),
    ].join("\n");
    const plan = this.deps.llm ? await this.deps.llm(prompt) : "stub: no LLM configured";
    return { run: true, planned: stale.length, message: plan };
  }

  private lastActivityAt(now: Date): number | null {
    const ep = rowOf(this.db, `SELECT MAX(created_at) AS m FROM episodes`);
    const epT = ep && ep["m"] ? Date.parse(String(ep["m"])) : NaN;
    if (Number.isFinite(epT)) return epT;
    const meta = this.readMetaDate(META_LAST_ACTIVITY);
    if (meta) return meta.getTime();
    return null;
  }

  private readMetaDate(key: string): Date | null {
    const row = rowOf(this.db, `SELECT value FROM meta WHERE key = ?`, key);
    if (!row) return null;
    const t = Date.parse(String(row["value"]));
    return Number.isFinite(t) ? new Date(t) : null;
  }

  private persistMeta(key: string, value: string): void {
    runStatement(
      this.db,
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }
}

export function lifecycleStateFor(row: Row, config: CuratorConfig, now: Date): LifecycleState {
  const created = Date.parse(String(row["created_at"] ?? ""));
  const lastUsed = Date.parse(String(row["last_used"] ?? ""));
  const lastRead = Date.parse(String(row["last_read_at"] ?? ""));
  let last = Number.isFinite(created) ? created : 0;
  if (Number.isFinite(lastUsed)) last = Math.max(last, lastUsed);
  if (Number.isFinite(lastRead)) last = Math.max(last, lastRead);
  if (!last) last = now.getTime();
  const days = Math.floor((now.getTime() - last) / 86_400_000);
  if (days >= config.archivedDays) return "archived";
  if (days >= config.staleDays) return "stale";
  return "active";
}

export function extractSteps(input: { trace?: unknown; steps?: string[] }): string[] {
  if (Array.isArray(input.steps)) {
    return input.steps.map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 20);
  }
  const actions = traceActions(input.trace);
  return actions.map(actionToStep).filter((s) => s.length > 0).slice(0, 20);
}

function traceActions(trace: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(trace)) return trace.filter(isRecord);
  if (isRecord(trace)) {
    const actions = trace["actions"];
    if (Array.isArray(actions)) return actions.filter(isRecord);
  }
  return [];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function actionToStep(a: Record<string, unknown>): string {
  const op = String(a["op"] ?? "").toUpperCase();
  if (!op) return "";
  let text = op;
  const url = typeof a["url"] === "string" ? a["url"] : "";
  if (op === "GOTO" || op === "NAVIGATE") {
    if (url) text += ` ${url}`;
  } else {
    if (op === "TYPE_TEXT" && typeof a["text"] === "string") text += ` "${a["text"]}"`;
    if (typeof a["index"] === "number") text += ` on element #${a["index"]}`;
    if (typeof a["text"] === "string" && op !== "TYPE_TEXT") text += ` "${a["text"]}"`;
  }
  if (a["ok"] === false) {
    const message = typeof a["message"] === "string" ? a["message"] : "action failed";
    text += ` — FAILED: ${message}`;
  }
  return text;
}

function goalOf(input: ProposeInput): string | null {
  if (isRecord(input.trace)) {
    const goal = input.trace["goal"] ?? input.trace["name"];
    if (typeof goal === "string" && goal.trim()) return goal.trim();
  }
  return null;
}

function deriveName(input: ProposeInput, steps: string[]): string {
  const fromTrace = isRecord(input.trace) ? input.trace["name"] : null;
  if (typeof fromTrace === "string" && fromTrace.trim()) return fromTrace.trim();
  if (steps.length > 0) {
    const first = steps[0]!.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (first) return first.slice(0, 40);
  }
  return `auto-${steps.length}-step-workflow`;
}

function buildProposedBody(name: string, description: string, steps: string[]): string {
  return [
    "## When to Use",
    description,
    "",
    "## Procedure",
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "## Pitfalls",
    "- Auto-generated from a finished task trace: review the steps before relying on them.",
    "- Element indexes and page state go stale between runs; re-observe before acting.",
    "",
    "## Verification",
    `- Confirm the workflow ends in the expected application state ("${name}").`,
  ].join("\n");
}

function isoOf(d: Date): string {
  return d.toISOString();
}
