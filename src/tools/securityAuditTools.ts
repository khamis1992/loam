import path from "node:path";
import type { Config } from "../config.js";
import type { OllamaClient } from "../ollama.js";
import { getAuditReport, getAuditStatus, startAudit } from "../security/audit/orchestrator.js";
import type { AuditOptions } from "../security/audit/types.js";
import type { Tool, ToolContext, ToolRegistry, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";

const PROFILES = ["quick", "standard", "deep"] as const;

/**
 * Source-code security audit tools. `security_audit_start` runs in the background and returns
 * at once; the other two only read the run directory. Static analysis only (no dynamic confirmation).
 */
export function createSecurityAuditTools(deps: { cfg: Config; ollama: OllamaClient; tools: ToolRegistry }): Tool[] {
  return [
    {
      name: "security_audit_start",
      description:
        "Start a static source-code security audit of a repository in the background. Returns a run_id; poll security_audit_status, then read security_audit_report. Profiles: quick (default from chat), standard, deep. Findings are confirmed, needs_validation or rejected; nothing is run dynamically.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Directory to audit. Defaults to the workspace." },
          profile: { type: "string", enum: [...PROFILES], description: "Audit depth. Defaults to quick." },
          scope_paths: { type: "array", items: { type: "string" }, description: "Optional sub-paths to limit the audit to." },
          budget: { type: "number", description: "Agent invocation budget. Minimum 6." },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const profile = str(args, "profile") || "quick";
        if (!(PROFILES as readonly string[]).includes(profile)) return { ok: false, content: `profile must be one of ${PROFILES.join(", ")}` };
        const raw = str(args, "target");
        const target = path.resolve(ctx.workspace, raw || ".");
        const scope = Array.isArray(args["scope_paths"]) ? (args["scope_paths"] as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
        const budget = args["budget"] === undefined || args["budget"] === null ? undefined : num(args, "budget", 0);
        const opts: AuditOptions = {
          target,
          profile: profile as AuditOptions["profile"],
          ...(scope?.length ? { scope_paths: scope } : {}),
          ...(budget !== undefined ? { budget } : {}),
        };
        try {
          const run = startAudit(opts, {
            cfg: deps.cfg, ollama: deps.ollama, tools: deps.tools,
            workspace: ctx.workspace,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
          });
          void run.done;
          return { ok: true, content: `Audit started: run_id=${run.run_id}\noutput_dir=${run.output_dir}\nCheck security_audit_status, then security_audit_report when stage is DONE.` };
        } catch (e) {
          return { ok: false, content: `could not start audit: ${String(e).slice(0, 300)}` };
        }
      },
    },
    {
      name: "security_audit_status",
      description: "Show the stage, budget, coverage and candidate counts of a security audit run.",
      parameters: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"] },
      async run(args: Record<string, unknown>): Promise<ToolResult> {
        const s = getAuditStatus(str(args, "run_id"));
        return s ? { ok: true, content: JSON.stringify(s, null, 2) } : { ok: false, content: "unknown run_id" };
      },
    },
    {
      name: "security_audit_report",
      description: "Return the report paths and the summary of a finished security audit run. If the run is still going, says so.",
      parameters: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"] },
      async run(args: Record<string, unknown>): Promise<ToolResult> {
        const r = getAuditReport(str(args, "run_id"));
        if (!r) return { ok: false, content: "unknown run_id" };
        if (r.in_progress) return { ok: true, content: "The audit is still running. Check security_audit_status." };
        const files = Object.entries(r.paths).map(([k, v]) => `${k}: ${v}`).join("\n");
        return { ok: true, content: `${files}\n\n${r.firstSection}` };
      },
    },
  ];
}

export const SECURITY_AUDIT_TOOL_NAMES = ["security_audit_start", "security_audit_status", "security_audit_report"];
