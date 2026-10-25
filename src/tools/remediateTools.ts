/** Agent tools for the Remediate engine — REMEDIATE_INTO_LOAM §6.2.
 *  Four tools in Security mode. These START and READ runs only; the three
 *  GATES are decided via the HTTP/UI endpoints and are never model tools
 *  (§0.1 rule 1). The local model is excluded from the chain (rule 9). */
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { startRemediation, readRun, listRuns, cancelRemediation } from "../security/remediate/index.js";
import { RemediationError } from "../security/remediate/errors.js";
import { planPaths } from "../security/remediate/store.js";
import fs from "node:fs";

export const REMEDIATE_TOOL_NAMES = ["remediation_start", "remediation_status", "remediation_report", "remediation_cancel"] as const;

const isLocalModel = (model: string | undefined): boolean => /ollama|local/i.test(model ?? "");

export function createRemediateTools(): Tool[] {
  return [
    {
      name: "remediation_start",
      description:
        "Start a verified vulnerability remediation run (inventory -> approval gates -> patch -> before/after tests -> one PR per repo -> re-scan). Returns {run_id} immediately. Does not edit anything until the user approves GATE 1 in the Security panel; no branch exists before that.",
      parameters: {
        type: "object",
        properties: {
          advisory_ids: { type: "array", items: { type: "string" }, description: "Pack ids, e.g. ['node-2026-10-21']. Default: all enabled packs." },
          repos: { type: "array", items: { type: "string" }, description: "Workspace-relative paths or owner/repo. Default: the active workspace only." },
          allow_docker: { type: "boolean", description: "Permit Docker build/test. Default false (patched_unverified path)." },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const model = (ctx.cfg as { model?: string } | undefined)?.model;
        if (isLocalModel(model)) return { ok: false, content: "remediation runs on a cloud model only — the local model is excluded from the remediation chain by design" };
        try {
          const run = await startRemediation({
            advisory_ids: Array.isArray(args["advisory_ids"]) ? (args["advisory_ids"] as string[]) : undefined,
            repos: Array.isArray(args["repos"]) ? (args["repos"] as string[]) : undefined,
            allow_docker: args["allow_docker"] === true,
          }, model ?? "cloud");
          const rows = run.inventory.length;
          const vulnerable = run.inventory.filter((r) => r.status === "vulnerable").length;
          const vendor = run.inventory.filter((r) => r.status === "vendor_update_required").length;
          return {
            ok: true,
            content: JSON.stringify({
              run_id: run.id,
              state: run.state,
              message: run.state === "awaiting_scope_approval"
                ? `الجرد اكتمل: ${rows} صفًّا (${vulnerable} قابلة للإصلاح، ${vendor} تحتاج تحديث مورّد). بوابة الموافقة تنتظر في لوحة الأمان — «الإصلاح المُتحقَّق». لا فرع ولا تعديل قبل موافقتك.`
                : run.incompleteReason === "no_vulnerable_rows" ? "لا صفوف متأثرة — لا شيء يحتاج إصلاحًا" : run.state,
            }),
          };
        } catch (err) {
          return { ok: false, content: err instanceof RemediationError ? err.message : `remediation_start failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "remediation_status",
      description: "Stage, inventory counts by status, gate state, per-repo progress, fix-gate verdicts.",
      parameters: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"] },
      async run(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
        const run = readRun(String(args["run_id"]));
        if (!run) return { ok: false, content: "unknown run_id" };
        return {
          ok: true,
          content: JSON.stringify({
            run_id: run.id, state: run.state,
            counts: run.inventory.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {}),
            gates: { scope: run.scopeApproval ? "approved" : "awaiting", repos: run.plans.map((p) => ({ repoId: p.repoId, phase: p.phase, fixGate: p.fixGate?.verdict ?? null })) },
            closures: run.closures.map((c) => ({ vulnId: c.vulnId, state: c.state })),
          }),
        };
      },
    },
    {
      name: "remediation_report",
      description: "Paths to REMEDIATION.md artifacts (per-repo PR bodies) and a summary; or 'in progress'.",
      parameters: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"] },
      async run(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
        const run = readRun(String(args["run_id"]));
        if (!run) return { ok: false, content: "unknown run_id" };
        const artifacts = run.plans.flatMap((p) => {
          const paths = planPaths(run.id, p.repoId);
          return fs.existsSync(paths.prBody) ? [{ repoId: p.repoId, prBody: paths.prBody }] : [];
        });
        return { ok: true, content: JSON.stringify({ run_id: run.id, state: run.state, artifacts }) };
      },
    },
    {
      name: "remediation_cancel",
      description: "Cancel a remediation run. Leaves worktrees and any uncommitted branches for the user to inspect; never force-deletes.",
      parameters: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"] },
      async run(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
        try {
          const run = cancelRemediation(String(args["run_id"]));
          return { ok: true, content: JSON.stringify({ run_id: run.id, state: run.state, note: "أُلغي التشغيل — الفروع غير الملتزمة متاحة للفحص في مخزن التشغيل" }) };
        } catch (err) {
          return { ok: false, content: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}
