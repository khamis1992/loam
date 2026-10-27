import path from "node:path";
import type { Tool, ToolContext } from "./registry.js";
import { inventoryMobileArtifacts } from "../security/mobile/artifacts.js";
import { authorizeMobileEngagement, MobileEngagementStore, recordMobileRetest, recordMobileScan, reviewMobileFinding, reviewMobileQa, setMobileCoverage, transitionMobileEngagement } from "../security/mobile/engagement.js";
import { MobSfClient, runMobileScan } from "../security/mobile/mobsfBridge.js";
import { buildMobileReport } from "../security/mobile/report.js";
import type { MasvsStatus } from "../security/mobile/masvs.js";

const text = (args: Record<string, unknown>, key: string): string => typeof args[key] === "string" ? String(args[key]).trim() : "";
const storeFor = (ctx: ToolContext): MobileEngagementStore => new MobileEngagementStore(path.join(ctx.workspace, ".loam", "mobile"));

export function createMobileSecurityTools(): Tool[] {
  return [{
    name: "mobile_engagement",
    description: "Run an authorized mobile engagement with hashed APK/IPA/AAB artifacts, real MobSF execution, reviewed MASVS coverage, independent QA, reports and retests. Unavailable engines are never reported as clean scans.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "authorize", "start", "scan", "coverage", "review-finding", "submit-qa", "qa", "deliver", "start-retest", "retest", "close", "status", "report"] },
        tenantId: { type: "string" }, ownerId: { type: "string" }, engagementId: { type: "string" },
        authorizationId: { type: "string" }, statement: { type: "string" }, expiresAt: { type: "string" }, approvedBy: { type: "string" },
        controlId: { type: "string" }, status: { type: "string" }, reason: { type: "string" }, evidenceIds: { type: "array", items: { type: "string" } },
        findingId: { type: "string" }, reviewerId: { type: "string" }, applicable: { type: "boolean" },
      },
      required: ["action"],
    },
    async run(args, ctx) {
      try {
        const action = text(args, "action");
        const tenantId = text(args, "tenantId") || "local";
        const ownerId = text(args, "ownerId") || "khamis";
        const store = storeFor(ctx);
        const id = text(args, "engagementId");
        if (action === "create") {
          const artifacts = await inventoryMobileArtifacts(ctx.workspace);
          const state = store.create({ tenantId, ownerId, artifacts });
          return { ok: true, content: JSON.stringify({ engagementId: state.id, stage: state.stage, artifacts: state.artifacts.map(({ relativePath, kind, sha256 }) => ({ relativePath, kind, sha256 })) }) };
        }
        if (!id) return { ok: false, content: "engagementId is required" };
        const state = store.get(tenantId, id);
        if (action === "status") return { ok: true, content: JSON.stringify(state) };
        if (action === "report") {
          const report = buildMobileReport(state, path.join(ctx.workspace, "mobile", state.id));
          return { ok: true, content: JSON.stringify(report) };
        }
        if (action === "authorize") {
          authorizeMobileEngagement(state, { id: text(args, "authorizationId"), statement: text(args, "statement"), expiresAt: text(args, "expiresAt"), approvedBy: text(args, "approvedBy") });
        } else if (action === "start") transitionMobileEngagement(state, "Running", ownerId);
        else if (action === "scan") {
          const baseUrl = process.env.LOAM_MOBSF_URL;
          const apiKey = process.env.LOAM_MOBSF_API_KEY;
          if (!baseUrl || !apiKey) return { ok: false, content: "MobSF is unavailable: configure LOAM_MOBSF_URL and LOAM_MOBSF_API_KEY" };
          const client = new MobSfClient({ baseUrl, apiKey });
          for (const result of await runMobileScan(state.artifacts, client)) recordMobileScan(state, result);
        } else if (action === "coverage") {
          const controlId = text(args, "controlId");
          const current = state.coverage.find((entry) => entry.controlId === controlId);
          if (!current) return { ok: false, content: "unknown MASVS controlId" };
          const status = text(args, "status") as MasvsStatus;
          if (!["covered", "partial", "not-tested", "not-applicable"].includes(status)) return { ok: false, content: "invalid MASVS status" };
          setMobileCoverage(state, { ...current, status, applicable: args["applicable"] !== false, reason: text(args, "reason"), evidenceIds: Array.isArray(args["evidenceIds"]) ? args["evidenceIds"].filter((value): value is string => typeof value === "string") : [] }, text(args, "reviewerId"));
        } else if (action === "review-finding") reviewMobileFinding(state, text(args, "findingId"), text(args, "reviewerId"));
        else if (action === "submit-qa") transitionMobileEngagement(state, "QA", ownerId);
        else if (action === "qa") reviewMobileQa(state, text(args, "reviewerId"));
        else if (action === "deliver") transitionMobileEngagement(state, "Delivered", text(args, "reviewerId"));
        else if (action === "start-retest") transitionMobileEngagement(state, "Retest", ownerId);
        else if (action === "retest") {
          const status = text(args, "status");
          if (!["fixed", "persistent", "inconclusive"].includes(status)) return { ok: false, content: "invalid retest status" };
          recordMobileRetest(state, text(args, "findingId"), { status: status as "fixed" | "persistent" | "inconclusive", evidenceIds: Array.isArray(args["evidenceIds"]) ? args["evidenceIds"].filter((value): value is string => typeof value === "string") : [], reviewerId: text(args, "reviewerId"), at: new Date().toISOString() });
        } else if (action === "close") transitionMobileEngagement(state, "Closed", text(args, "reviewerId"));
        else return { ok: false, content: `unsupported action ${action}` };
        store.update(state);
        return { ok: true, content: JSON.stringify({ engagementId: state.id, stage: state.stage, findings: state.findings.length, scans: state.scans.map((scan) => ({ artifact: scan.artifact.relativePath, status: scan.status, detail: scan.detail })) }) };
      } catch (error) {
        return { ok: false, content: `mobile_engagement failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 400)}` };
      }
    },
  }];
}

export const MOBILE_SECURITY_TOOL_NAMES = ["mobile_engagement"] as const;
