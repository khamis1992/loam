/**
 * lazy-senior P4 metrics band: derive a task's compact metrics line from its
 * recorded step log. Pure aggregation — no I/O — so the HTTP route and the
 * tests share one definition of every number. Local data only; nothing here
 * leaves the machine.
 */
import type { StepRecord } from "./db.js";

export interface TaskMetrics {
  /** Completed model turns as reported by the run's done step. */
  turns: number | null;
  /** Final model that produced the task result. */
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  /** Wall-clock from the first step to the done step, when both exist. */
  elapsedMs: number | null;
  toolCalls: number;
  filesTouched: number;
  newFiles: number;
  linesAdded: number;
  linesRemoved: number;
  /** Existing files / touched files — reads before a write mark a file as existing. */
  reuseRatio: number | null;
  /** The last verification-shaped shell command's outcome. */
  lastCheck: "pass" | "fail" | null;
}

const FILE_TOOLS = new Set(["file_write", "file_edit", "file_multi_edit", "find_and_edit"]);
const READ_TOOLS = new Set(["file_read", "file_stat", "file_list"]);

function countLines(value: unknown): number {
  if (typeof value !== "string" || value.length === 0) return 0;
  return value.split(/\r\n|\r|\n/).length;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function normalizePath(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

interface MutableMetrics extends Omit<TaskMetrics, "reuseRatio" | "lastCheck" | "turns" | "model" | "tokensIn" | "tokensOut" | "elapsedMs"> {
  turns: number | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  elapsedMs: number | null;
  reuseRatio: number | null;
  readPaths: Set<string>;
  touchedPaths: Set<string>;
  lastCheck: "pass" | "fail" | null;
  pendingCheck: boolean;
}

export function computeTaskMetrics(steps: readonly StepRecord[]): TaskMetrics {
  const m: MutableMetrics = {
    turns: null, model: null, tokensIn: null, tokensOut: null, elapsedMs: null,
    toolCalls: 0, filesTouched: 0, newFiles: 0, linesAdded: 0, linesRemoved: 0,
    lastCheck: null, pendingCheck: false, reuseRatio: null,
    readPaths: new Set(), touchedPaths: new Set(),
  };
  let firstAt: number | null = null;
  let doneAt: number | null = null;
  for (const step of steps) {
    const at = Date.parse(step.at);
    if (!Number.isNaN(at) && firstAt === null) firstAt = at;
    const data = asRecord(step.data);
    if (step.type === "tool_call") {
      m.toolCalls += 1;
      const name = typeof data.name === "string" ? data.name : "";
      const args = asRecord(data.args);
      if (READ_TOOLS.has(name)) {
        const path = normalizePath(args.path);
        if (path) m.readPaths.add(path);
      }
      if (FILE_TOOLS.has(name)) {
        const path = normalizePath(args.path);
        const edits = Array.isArray(args.edits) ? args.edits.map(asRecord) : null;
        if (path) m.touchedPaths.add(path);
        if (name === "file_write") {
          m.linesAdded += countLines(args.content);
        } else if (name === "file_edit" || name === "find_and_edit") {
          m.linesRemoved += countLines(args.find);
          m.linesAdded += countLines(args.replace);
        } else if (edits) {
          for (const edit of edits) {
            m.linesRemoved += countLines(edit.find);
            m.linesAdded += countLines(edit.replace);
          }
        }
      }
      // A verification-shaped shell command opens a check; its result closes it.
      if (name === "shell_run") {
        const command = typeof args.command === "string" ? args.command : "";
        if (/(^|\s|-)(test|typecheck|vitest|tsc|pytest)(\s|$|")|\bcheck:[a-z-]+/.test(command)) {
          m.pendingCheck = true;
          m.lastCheck = null;
        }
      }
    } else if (step.type === "tool_result") {
      if (m.pendingCheck) {
        m.lastCheck = data.ok === true ? "pass" : "fail";
        m.pendingCheck = false;
      }
    } else if (step.type === "usage") {
      if (typeof data.promptTokens === "number") m.tokensIn = data.promptTokens;
      if (typeof data.completionTokens === "number") m.tokensOut = data.completionTokens;
      if (typeof data.model === "string") m.model = data.model;
    } else if (step.type === "done") {
      doneAt = Number.isNaN(at) ? null : at;
      if (typeof data.steps === "number") m.turns = data.steps;
      if (typeof data.model === "string") m.model = data.model;
    }
  }
  m.filesTouched = m.touchedPaths.size;
  m.newFiles = [...m.touchedPaths].filter((path) => !m.readPaths.has(path)).length;
  m.reuseRatio = m.filesTouched > 0 ? (m.filesTouched - m.newFiles) / m.filesTouched : null;
  if (firstAt !== null && doneAt !== null && doneAt >= firstAt) m.elapsedMs = doneAt - firstAt;
  const { readPaths: _read, touchedPaths: _touched, pendingCheck: _pending, ...rest } = m;
  return rest;
}

/** One compact localization-friendly row: every metric that has a value. */
export function metricsRows(metrics: TaskMetrics): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  if (metrics.tokensIn !== null || metrics.tokensOut !== null) {
    rows.push({ label: "tokens", value: `${metrics.tokensIn ?? "?"} in / ${metrics.tokensOut ?? "?"} out` });
  }
  if (metrics.elapsedMs !== null) rows.push({ label: "time", value: `${Math.round(metrics.elapsedMs / 1000)}s` });
  if (metrics.turns !== null) rows.push({ label: "turns", value: String(metrics.turns) });
  if (metrics.filesTouched > 0) {
    rows.push({ label: "files", value: String(metrics.filesTouched) });
    rows.push({ label: "lines", value: `+${metrics.linesAdded}/-${metrics.linesRemoved}` });
    if (metrics.reuseRatio !== null) {
      rows.push({ label: "reuse", value: `${Math.round(metrics.reuseRatio * 100)}%` });
    }
  }
  if (metrics.lastCheck !== null) rows.push({ label: "check", value: metrics.lastCheck === "pass" ? "pass" : "fail" });
  return rows;
}
