/**
 * Coverage ledger tools (Strix `tools/coverage` parity).
 *
 * `coverage_record` is meant to be called for every surface assessed, including
 * the clean ones: a clean surface still proves it was looked at. `coverage_report`
 * turns the ledger into the negative space plus the open proof gaps, so a "done"
 * claim can be audited instead of trusted.
 */
import {
  coverageReport,
  deleteCoverage,
  formatCoverageReport,
  listCoverage,
  recordCoverage,
  updateCoverage,
  type CoverageStatus,
} from "../server/coverageStore.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";

const STATUSES: CoverageStatus[] = ["covered", "partial", "error", "skipped"];

function taskFor(args: Record<string, unknown>, ctx: ToolContext): string {
  return str(args, "task_id").trim() || ctx.taskId || ctx.agentId || "workspace";
}

function statusArg(args: Record<string, unknown>): CoverageStatus | undefined {
  const value = str(args, "status") as CoverageStatus;
  return STATUSES.includes(value) ? value : undefined;
}

function notesArg(args: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(args["notes"])) return undefined;
  return (args["notes"] as unknown[]).filter((n): n is string => typeof n === "string");
}

function formatEntry(entry: { id: string; target: string; check: string; status: string; findingCount: number; notes: string[] }): string {
  return `${entry.id} ${entry.target} — ${entry.check} [${entry.status}] findings=${entry.findingCount}${entry.notes.length ? ` (${entry.notes.join("; ")})` : ""}`;
}

export function createCoverageTools(): Tool[] {
  return [
    {
      name: "coverage_record",
      description:
        "Record one surface you assessed and how it ended: target (URL, route, file or component) + check (what you tested). Record clean results too — a covered surface with zero findings is the negative space that makes the scan auditable. Say 'partial' or 'error' rather than claiming a clean result you did not get.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task that owns the ledger. Defaults to the current task." },
          target: { type: "string", description: "URL, route, file or component assessed." },
          check: { type: "string", description: "The check performed on that target." },
          engine: { type: "string", description: "Who performed it (defaults to 'agent')." },
          status: { type: "string", enum: STATUSES, description: "Outcome; defaults to covered, or partial when notes are given." },
          finding_count: { type: "number", description: "Findings produced for this target+check." },
          notes: { type: "array", items: { type: "string" }, description: "Why it is partial/error/skipped, or context." },
        },
        required: ["target", "check"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const taskId = taskFor(args, ctx);
        try {
          const entry = recordCoverage(taskId, {
            target: str(args, "target"),
            check: str(args, "check"),
            engine: str(args, "engine"),
            status: statusArg(args),
            findingCount: args["finding_count"] === undefined ? undefined : num(args, "finding_count", 0),
            notes: notesArg(args),
          });
          return { ok: true, content: `recorded ${formatEntry(entry)}` };
        } catch (err) {
          return { ok: false, content: `coverage_record failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "coverage_update",
      description: "Update one coverage entry by id when the outcome changed (e.g. a partial surface was finished, or its finding count moved).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          task_id: { type: "string" },
          status: { type: "string", enum: STATUSES },
          finding_count: { type: "number" },
          notes: { type: "array", items: { type: "string" } },
          engine: { type: "string" },
        },
        required: ["id"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const taskId = taskFor(args, ctx);
        const entry = updateCoverage(taskId, str(args, "id").trim(), {
          status: statusArg(args),
          findingCount: args["finding_count"] === undefined ? undefined : num(args, "finding_count", 0),
          ...(notesArg(args) !== undefined ? { notes: notesArg(args) } : {}),
          engine: str(args, "engine"),
        });
        return entry ? { ok: true, content: `updated ${formatEntry(entry)}` } : { ok: false, content: "coverage entry not found" };
      },
    },
    {
      name: "coverage_list",
      description: "List the task's coverage entries, optionally filtered by status.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string" }, status: { type: "string", enum: STATUSES } },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const entries = listCoverage(taskFor(args, ctx), statusArg(args));
        return { ok: true, content: entries.length ? entries.map(formatEntry).join("\n") : "(no coverage entries)" };
      },
    },
    {
      name: "coverage_report",
      description:
        "Report the ledger: open proof gaps (partial/error), the cleared negative space and findings by target, as markdown. Run it before finishing and cite the gaps you left open.",
      parameters: { type: "object", properties: { task_id: { type: "string" } } },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        return { ok: true, content: formatCoverageReport(coverageReport(taskFor(args, ctx))) };
      },
    },
    {
      name: "coverage_delete",
      description: "Delete one coverage entry that was recorded in error.",
      parameters: { type: "object", properties: { id: { type: "string" }, task_id: { type: "string" } }, required: ["id"] },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const removed = deleteCoverage(taskFor(args, ctx), str(args, "id").trim());
        return { ok: removed, content: removed ? "deleted" : "coverage entry not found" };
      },
    },
  ];
}
