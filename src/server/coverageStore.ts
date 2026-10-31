/**
 * Task-scoped coverage ledger (Strix `tools/coverage` parity).
 *
 * `src/security/coverage/ledger.ts` is the scanners' in-memory ledger for one
 * orchestrator run. Agents need the same discipline across the whole task, and
 * they need it to survive the process: every surface assessed is recorded with
 * its outcome, including the clean ones, so "done" is auditable and the report
 * can show the negative space (what was looked at and cleared) next to the open
 * proof gaps.
 */
import crypto from "node:crypto";
import { database, transaction } from "./sqliteStore.js";

export const MAX_ENTRIES = 500;
export const MAX_TEXT = 400;

export type CoverageStatus = "covered" | "partial" | "error" | "skipped";

export interface CoverageEntry {
  id: string;
  taskId: string;
  target: string;
  check: string;
  engine: string;
  status: CoverageStatus;
  findingCount: number;
  notes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CoverageInput {
  target?: unknown;
  check?: unknown;
  engine?: unknown;
  status?: unknown;
  findingCount?: unknown;
  notes?: unknown;
}

const STATUSES = new Set<CoverageStatus>(["covered", "partial", "error", "skipped"]);

function ensureTable(): void {
  const db = database();
  db.exec(`CREATE TABLE IF NOT EXISTS coverage_entries (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    target TEXT NOT NULL,
    check_name TEXT NOT NULL,
    engine TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('covered','partial','error','skipped')),
    finding_count INTEGER NOT NULL DEFAULT 0,
    notes_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_coverage_unique ON coverage_entries(task_id, target, check_name);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_coverage_task ON coverage_entries(task_id, created_at);`);
}

ensureTable();

function text(value: unknown, max = MAX_TEXT): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function notes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((n) => text(n)).filter((n) => n.length > 0).slice(0, 20);
}

function rowToEntry(row: Record<string, unknown>): CoverageEntry {
  let parsed: string[] = [];
  try {
    const raw = JSON.parse(String(row.notes_json));
    if (Array.isArray(raw)) parsed = raw.filter((n): n is string => typeof n === "string");
  } catch {
    parsed = [];
  }
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    target: String(row.target),
    check: String(row.check_name),
    engine: String(row.engine),
    status: row.status as CoverageStatus,
    findingCount: Number(row.finding_count ?? 0),
    notes: parsed,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** Record (or refresh) the entry for one target+check. Errors imply partial coverage, never silent success. */
export function recordCoverage(taskId: string, input: CoverageInput): CoverageEntry {
  const target = text(input.target, 300);
  const check = text(input.check, 200);
  if (!target) throw new Error("coverage target is required");
  if (!check) throw new Error("coverage check is required");
  const declared = text(input.status, 20) as CoverageStatus;
  const entryNotes = notes(input.notes);
  const status: CoverageStatus = STATUSES.has(declared)
    ? declared
    : entryNotes.length
      ? "partial"
      : "covered";
  const engine = text(input.engine, 120) || "agent";
  const findingCount = typeof input.findingCount === "number" && Number.isFinite(input.findingCount) && input.findingCount > 0
    ? Math.floor(input.findingCount)
    : 0;
  const now = new Date().toISOString();
  return transaction(() => {
    const db = database();
    const existing = db
      .prepare("SELECT id, created_at FROM coverage_entries WHERE task_id = ? AND target = ? AND check_name = ?")
      .get(taskId, target, check) as { id: string; created_at: string } | undefined;
    if (existing) {
      db.prepare(
        "UPDATE coverage_entries SET engine = ?, status = ?, finding_count = ?, notes_json = ?, updated_at = ? WHERE id = ?",
      ).run(engine, status, findingCount, JSON.stringify(entryNotes), now, existing.id);
      const row = db.prepare("SELECT * FROM coverage_entries WHERE id = ?").get(existing.id) as Record<string, unknown>;
      return rowToEntry(row);
    }
    const id = `cov_${crypto.randomBytes(6).toString("hex")}`;
    db.prepare(
      "INSERT INTO coverage_entries (id, task_id, target, check_name, engine, status, finding_count, notes_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, taskId, target, check, engine, status, findingCount, JSON.stringify(entryNotes), now, now);
    const row = db.prepare("SELECT * FROM coverage_entries WHERE id = ?").get(id) as Record<string, unknown>;
    return rowToEntry(row);
  });
}

/** Update an existing entry by id; a null field is left unchanged. */
export function updateCoverage(taskId: string, id: string, patch: CoverageInput): CoverageEntry | undefined {
  return transaction(() => {
    const db = database();
    const row = db.prepare("SELECT * FROM coverage_entries WHERE id = ? AND task_id = ?").get(id, taskId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const current = rowToEntry(row);
    const status = text(patch.status, 20) as CoverageStatus;
    const nextNotes = patch.notes === undefined ? current.notes : notes(patch.notes);
    const findingCount = typeof patch.findingCount === "number" && Number.isFinite(patch.findingCount)
      ? Math.max(0, Math.floor(patch.findingCount))
      : current.findingCount;
    db.prepare(
      "UPDATE coverage_entries SET status = ?, finding_count = ?, notes_json = ?, engine = ?, updated_at = ? WHERE id = ?",
    ).run(
      STATUSES.has(status) ? status : current.status,
      findingCount,
      JSON.stringify(nextNotes),
      text(patch.engine, 120) || current.engine,
      new Date().toISOString(),
      id,
    );
    return rowToEntry(db.prepare("SELECT * FROM coverage_entries WHERE id = ?").get(id) as Record<string, unknown>);
  });
}

export function listCoverage(taskId: string, status?: CoverageStatus): CoverageEntry[] {
  const db = database();
  const rows = status
    ? db.prepare("SELECT * FROM coverage_entries WHERE task_id = ? AND status = ? ORDER BY created_at ASC").all(taskId, status)
    : db.prepare("SELECT * FROM coverage_entries WHERE task_id = ? ORDER BY created_at ASC").all(taskId);
  return (rows as Record<string, unknown>[]).map(rowToEntry);
}

export function deleteCoverage(taskId: string, id: string): boolean {
  return Number(database().prepare("DELETE FROM coverage_entries WHERE id = ? AND task_id = ?").run(id, taskId).changes) > 0;
}

export interface CoverageReport {
  taskId: string;
  total: number;
  counts: Record<CoverageStatus, number>;
  /** The negative space: assessed and cleared, kept as evidence that it was looked at. */
  cleared: CoverageEntry[];
  /** Open proof gaps: partial coverage and scanner/agent errors. */
  gaps: CoverageEntry[];
  skipped: CoverageEntry[];
  findingsByTarget: Array<{ target: string; findings: number }>;
}

/** Assemble the report; `cleared` is what makes a "done" claim auditable. */
export function coverageReport(taskId: string): CoverageReport {
  const entries = listCoverage(taskId);
  const counts: Record<CoverageStatus, number> = { covered: 0, partial: 0, error: 0, skipped: 0 };
  const byTarget = new Map<string, number>();
  for (const entry of entries) {
    counts[entry.status] += 1;
    if (entry.findingCount > 0) byTarget.set(entry.target, (byTarget.get(entry.target) ?? 0) + entry.findingCount);
  }
  return {
    taskId,
    total: entries.length,
    counts,
    cleared: entries.filter((e) => e.status === "covered" && e.findingCount === 0),
    gaps: entries.filter((e) => e.status === "partial" || e.status === "error"),
    skipped: entries.filter((e) => e.status === "skipped"),
    findingsByTarget: [...byTarget.entries()]
      .map(([target, findings]) => ({ target, findings }))
      .sort((a, b) => b.findings - a.findings),
  };
}

/** Markdown rendering of the report, for a report file or the finish summary. */
export function formatCoverageReport(report: CoverageReport): string {
  const lines = [
    `# Coverage — ${report.taskId}`,
    "",
    `Assessed surfaces: ${report.total} (covered ${report.counts.covered}, partial ${report.counts.partial}, error ${report.counts.error}, skipped ${report.counts.skipped})`,
  ];
  lines.push("", "## Open proof gaps", "");
  if (report.gaps.length === 0) lines.push("(none)");
  for (const gap of report.gaps) {
    lines.push(`- ${gap.target} — ${gap.check} [${gap.status}]${gap.notes.length ? `: ${gap.notes.join("; ")}` : ""}`);
  }
  lines.push("", "## Cleared (negative space)", "");
  if (report.cleared.length === 0) lines.push("(none)");
  for (const entry of report.cleared) lines.push(`- ${entry.target} — ${entry.check}`);
  if (report.findingsByTarget.length) {
    lines.push("", "## Findings by target", "");
    for (const item of report.findingsByTarget) lines.push(`- ${item.target}: ${item.findings}`);
  }
  return lines.join("\n");
}

export function clearCoverage(taskId: string): void {
  database().prepare("DELETE FROM coverage_entries WHERE task_id = ?").run(taskId);
}

export { MAX_ENTRIES as MAX_COVERAGE_ENTRIES };
