import path from "node:path";
import type http from "node:http";
import { mergeUnifiedCoverage, summarizeUnifiedCoverage, type UnifiedCoverageEntry } from "../security/coverage/unified.js";
import { rankHypotheses, type SecurityHypothesis } from "../security/hypothesis.js";
import { inspectSpaJavaScript, reviewWebSocketHandshake, testGraphQLAuthorization } from "../security/web/protocols.js";
import { loadAuthorization, defaultDataRoot } from "../security/red/gate.js";
import { MobileInstrumentationProvider, type InstrumentAction } from "../security/mobile/instrumentation.js";
import { EvidenceTimeline } from "../security/mobile/evidenceTimeline.js";
import { MobileEngagementStore } from "../security/mobile/engagement.js";
import { configuredEvidenceCipher } from "../security/enterprise/runtime.js";
import { SecurityPluginRegistry, type SecurityPluginManifest } from "../security/plugins.js";
import { groupByRootCause, type RootCauseFinding } from "../security/rootCause.js";
import { requirePermission } from "../security/enterprise/policy.js";
import { authenticateEnterpriseRequest, type SecurityEnterpriseRouteDeps } from "./securityEnterpriseRoutes.js";

const text = (body: Record<string, unknown>, key: string): string => typeof body[key] === "string" ? String(body[key]).trim() : "";
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  return value as Record<string, unknown>;
};
const account = (body: Record<string, unknown>, key: string) => {
  const value = object(body[key]);
  const headers: Record<string, string> = {};
  if (value.headers && typeof value.headers === "object" && !Array.isArray(value.headers)) for (const [name, header] of Object.entries(value.headers).slice(0, 10)) if (typeof header === "string") headers[name.toLowerCase()] = header;
  return { id: text(value, "id") || key, ...(Object.keys(headers).length ? { headers } : {}) };
};

export async function handleAdvancedSecurityRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: SecurityEnterpriseRouteDeps): Promise<boolean> {
  const prefix = "/api/security/advanced";
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
  res.setHeader("cache-control", "no-store");
  try {
    const identity = await (deps.identity ?? authenticateEnterpriseRequest)(req);
    if (req.method !== "POST") return deps.sendJson(res, 405, { error: "POST required" }), true;
    if ((req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || req.headers["sec-fetch-site"] === "cross-site") return deps.sendJson(res, 403, { error: "same-origin requests required" }), true;
    if (!req.headers["content-type"]?.startsWith("application/json")) return deps.sendJson(res, 415, { error: "application/json required" }), true;
    const body = object(await deps.readBody(req, 2_200_000));
    const tenantId = text(body, "tenantId") || identity.tenantIds[0]!;
    const area = url.pathname.slice(prefix.length).split("/").filter(Boolean)[0] ?? "";
    requirePermission(identity, tenantId, area === "plugins" ? "admin:write" : area === "coverage" || area === "root-cause" ? "finding:review" : "engagement:execute");
    const root = deps.dataRoot ?? defaultDataRoot();

    if (area === "coverage") {
      const entries = Array.isArray(body.entries) ? body.entries as UnifiedCoverageEntry[] : [];
      return deps.sendJson(res, 200, { summary: summarizeUnifiedCoverage(mergeUnifiedCoverage(entries)) }), true;
    }
    if (area === "hypotheses") {
      const hypotheses = Array.isArray(body.hypotheses) ? body.hypotheses as SecurityHypothesis[] : [];
      return deps.sendJson(res, 200, { execution: "none", hypotheses: rankHypotheses(hypotheses) }), true;
    }
    if (area === "graphql") {
      const authz = loadAuthorization(text(body, "authorizationId"), root);
      if (!authz) return deps.sendJson(res, 403, { error: "signed authorization is unavailable" }), true;
      const result = await testGraphQLAuthorization(authz, { url: text(body, "url"), query: text(body, "query"), privateMarker: text(body, "privateMarker"), ownerIdentity: text(body, "ownerIdentity") }, account(body, "owner"), account(body, "other"));
      return deps.sendJson(res, 200, { result }), true;
    }
    if (area === "websocket") {
      const result = reviewWebSocketHandshake({ url: text(body, "url"), status: Number(body.status), ...(text(body, "origin") ? { origin: text(body, "origin") } : {}), ...(text(body, "expectedOrigin") ? { expectedOrigin: text(body, "expectedOrigin") } : {}), authenticated: body.authenticated === true, requiresAuthentication: body.requiresAuthentication === true, ...(body.reconnectStatus === undefined ? {} : { reconnectStatus: Number(body.reconnectStatus) }) });
      return deps.sendJson(res, 200, { result }), true;
    }
    if (area === "spa") return deps.sendJson(res, 200, { result: inspectSpaJavaScript(text(body, "source")) }), true;
    if (area === "root-cause") return deps.sendJson(res, 200, { groups: groupByRootCause(Array.isArray(body.findings) ? body.findings as RootCauseFinding[] : []) }), true;
    if (area === "instrumentation") {
      const engagementId = text(body, "engagementId");
      new MobileEngagementStore(path.join(deps.workspace, ".loam", "mobile")).get(tenantId, engagementId);
      const provider = new MobileInstrumentationProvider({ baseUrl: process.env.LOAM_INSTRUMENTATION_URL ?? "", apiKey: process.env.LOAM_INSTRUMENTATION_API_KEY ?? "", deviceSerial: text(body, "deviceSerial"), packageName: text(body, "packageName") });
      const timeline = new EvidenceTimeline(path.join(root, "timeline"), configuredEvidenceCipher() ?? undefined);
      const relatedFindingIds = Array.isArray(body.relatedFindingIds) ? body.relatedFindingIds.filter((value): value is string => typeof value === "string") : [];
      const event = await provider.capture(timeline, tenantId, engagementId, text(body, "action") as InstrumentAction, relatedFindingIds);
      const { encrypted: _encrypted, ...safe } = event;
      return deps.sendJson(res, 201, { event: safe }), true;
    }
    if (area === "plugins") {
      const key = Buffer.from(process.env.LOAM_PLUGIN_SIGNING_KEY ?? "", "base64");
      const registry = new SecurityPluginRegistry(key, ["web", "mobile", "api"]);
      registry.register(body.manifest as SecurityPluginManifest);
      return deps.sendJson(res, 201, { plugins: registry.list() }), true;
    }
    return deps.sendJson(res, 404, { error: "advanced security endpoint not found" }), true;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    deps.sendJson(res, /permission denied|tenant|identity|token|authorization/.test(message) ? 403 : 400, { error: message });
    return true;
  }
}
