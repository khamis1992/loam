/**
 * Agent-facing red-team tools (RED_TEAM_BUILD_SPEC §4.5, §6.1).
 *
 * `red_campaign` runs one gated campaign against an authorized target and
 * writes the report bundle (SARIF + Markdown + PoC artifacts) into the
 * workspace. `red_report` re-opens a stored report. VulnClaw's "MCP surface"
 * graft maps to this ToolRegistry surface — Loam's native agent tool protocol.
 */
import path from "node:path";
import fs from "node:fs";
import type { Tool, ToolContext } from "../tools/registry.js";
import { runBridge } from "../bridges/exec.js";
import { runBridgeDetached } from "../bridges/exec.js";
import { defaultRedCapabilities } from "../security/red/capabilities.js";
import { gate, defaultDataRoot } from "../security/red/gate.js";
import { runCampaign, type BridgeCaller } from "../security/red/orchestrator/redOrchestrator.js";
import { llmPlanner, type RedPlanner } from "../security/red/orchestrator/planner.js";
import { setRedKillSwitch } from "../security/red/control.js";
import { buildRedReport } from "../security/red/report.js";

const str = (args: Record<string, unknown>, key: string): string => (typeof args[key] === "string" ? (args[key] as string) : "");

const bridgeCallerFor = (ctx: ToolContext): BridgeCaller => (bridgeId, commandId, args) =>
  runBridge(ctx, bridgeId, commandId, args);

const bridgeDaemonFor = (ctx: ToolContext) => (bridgeId: string, commandId: string, args: Record<string, unknown>) =>
  runBridgeDetached(ctx, bridgeId, commandId, args);

/** Model-driven planner wired to the local model (§6.1); proposals stay evidence-gated. */
const plannerFor = (ctx: ToolContext, plan: string): RedPlanner | undefined => {
  if (plan !== "auto" || !ctx.ollama) return undefined;
  return llmPlanner(async (prompt) => {
    const r = await ctx.ollama!.chat({ model: "loam", messages: [{ role: "user", content: prompt }], temperature: 0.2, timeoutMs: 120_000, signal: ctx.signal });
    return r.content;
  });
};

export function redTools(): Tool[] {
  return [
    {
      name: "red_campaign",
      description:
        "Run an authorized, evidence-gated red-team campaign against one target (default posture: http://127.0.0.1 only; wider targets need a signed authorization record id). Writes SARIF + Markdown + PoC artifacts under red/<campaignId>/ in the workspace.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Authorized target URL (e.g. http://127.0.0.1:3000)" },
          authzId: { type: "string", description: "AuthorizationRecord id (AUTHZ-####) for non-localhost targets; omit for the localhost default posture" },
          profile: { type: "string", description: "'quick' (default) or 'campaign'" },
          plan: { type: "string", description: "'auto' uses model-driven planning (proposals still pass the evidence gate); default 'off'" },
          approveExternal: { type: "boolean", description: "Explicit operator approval for external/exec_script bridge effects (required when installed engines are used)" },
        },
        required: ["target"],
      },
      async run(args, ctx): Promise<{ ok: boolean; content: string }> {
        const target = str(args, "target");
        const authzId = str(args, "authzId") || null;
        const profile = str(args, "profile") === "campaign" ? "campaign" : "quick";
        const plan = str(args, "plan") === "auto" ? "auto" : "off";
        if (!target) return { ok: false, content: "red_campaign requires a target URL" };
        // Fail fast with a clear message when the gate would deny the whole campaign.
        const decision = gate(target, { capability: "red.campaign", verb: "read" }, null);
        if (!decision.allow && !authzId) {
          return { ok: false, content: `Target ${target} is outside the localhost default posture (${decision.reason}); provide an authzId after signing an authorization record.` };
        }
        const capabilities = await defaultRedCapabilities(ctx.cfg, { ssrf: { probeTemplate: undefined } });
        if (capabilities.some((cap) => cap.id !== "red.ssrf") && args["approveExternal"] !== true) {
          return {
            ok: false,
            content: "External/exec_script engines are available for this campaign but were not approved. Rerun with approveExternal: true after reviewing the target, scope and engine effects.",
          };
        }
        const result = await runCampaign(
          { goal: `Red campaign on ${target}`, authzId, targets: [target], profile },
          { dataRoot: defaultDataRoot(), bridge: bridgeCallerFor(ctx), capabilities, planner: plannerFor(ctx, plan), workspace: ctx.workspace, bridgeApproval: () => true, bridgeDaemon: bridgeDaemonFor(ctx) },
        );
        const outDir = path.join(ctx.workspace, "red", result.campaignId);
        const report = buildRedReport(result, outDir);
        const summary = [
          `red_campaign ${result.campaignId} on ${target}:`,
          `- ${result.findings.length} proven finding(s), ${result.unverified.length} unverified claim(s)`,
          `- ${result.stats.requestsSent} gated request(s) in ${Math.round((Date.parse(result.stats.finishedAt) - Date.parse(result.stats.startedAt)) / 100) / 10}s`,
          result.stats.killed ? "- campaign killed by kill-switch" : "",
          result.stats.aborted === "budget" ? "- aborted: request budget reached" : "",
          `- report: ${path.relative(ctx.workspace, report.markdownPath).replace(/\\/g, "/")}`,
          `- SARIF: ${path.relative(ctx.workspace, report.sarifPath).replace(/\\/g, "/")}`,
          result.findings.map((f) => `  * [${f.severity}] ${f.title} (${f.check})`).join("\n"),
          result.unverified.map((u) => `  ? ${u.title} — ${u.reason}`).join("\n"),
        ]
          .filter(Boolean)
          .join("\n");
        return { ok: true, content: summary };
      },
    },
    {
      name: "red_kill_switch",
      description: "Engage or reset the global red-team kill-switch. Engaging immediately blocks new red actions and aborts in-flight red requests; the action is audited.",
      parameters: {
        type: "object",
        properties: { engage: { type: "boolean", description: "true to stop all red activity, false to reset" } },
        required: ["engage"],
      },
      async run(args): Promise<{ ok: boolean; content: string }> {
        if (typeof args["engage"] !== "boolean") return { ok: false, content: "red_kill_switch requires engage: boolean" };
        const state = setRedKillSwitch(args["engage"] as boolean);
        return { ok: true, content: state.engaged ? "Kill-switch ENGAGED: all red actions are blocked and in-flight requests abort." : "Kill-switch reset: red actions may run again." };
      },
    },
    {
      name: "red_report",
      description: "Re-open a stored red-team campaign report (Markdown body) from red/<campaignId>/ in the workspace.",
      parameters: {
        type: "object",
        properties: { campaignId: { type: "string", description: "Campaign id (e.g. RED-lx2abc-1) from a previous red_campaign run" } },
        required: ["campaignId"],
      },
      async run(args, ctx): Promise<{ ok: boolean; content: string }> {
        const campaignId = str(args, "campaignId").replace(/[^\w-]/g, "");
        if (!campaignId) return { ok: false, content: "red_report requires a campaignId" };
        const reportPath = path.join(ctx.workspace, "red", campaignId, "report.md");
        if (!fs.existsSync(reportPath)) return { ok: false, content: `No report found for ${campaignId}` };
        return { ok: true, content: fs.readFileSync(reportPath, "utf8") };
      },
    },
  ];
}
