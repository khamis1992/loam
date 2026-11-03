import path from "node:path";
import type http from "node:http";
import { inventoryMobileArtifacts } from "../security/mobile/artifacts.js";
import { authorizeMobileEngagement, MobileEngagementStore, recordMobileRetest, recordMobileScan, reviewMobileFinding, reviewMobileQa, setMobileCoverage, transitionMobileEngagement, type MobileEngagement } from "../security/mobile/engagement.js";
import { MobSfClient, runMobileScan } from "../security/mobile/mobsfBridge.js";
import { buildProtectedMobileReport, readProtectedMobileMarkdown } from "../security/mobile/secureReport.js";
import type { MasvsStatus } from "../security/mobile/masvs.js";
import { EnterpriseQueue } from "../security/enterprise/queue.js";
import { SharedKillSwitch } from "../security/enterprise/killSwitch.js";
import { localEnterpriseIdentity, requirePermission, type EnterpriseIdentity, type Permission } from "../security/enterprise/policy.js";
import { OidcVerifier, verifySamlGatewayIdentity } from "../security/enterprise/oidc.js";
import { configuredEvidenceCipher, configuredSiemExporter } from "../security/enterprise/runtime.js";
import { configureSharedKillState, defaultDataRoot, engageKillSwitch, resetKillSwitch } from "../security/red/gate.js";

export interface SecurityEnterpriseRouteDeps {
  workspace: string;
  sendJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readBody: (req: http.IncomingMessage, maxBytes?: number) => Promise<unknown>;
  identity?: (req: http.IncomingMessage) => Promise<EnterpriseIdentity>;
  dataRoot?: string;
}

const publicState = (state: MobileEngagement): MobileEngagement => ({
  ...state,
  artifacts: state.artifacts.map((artifact) => ({ ...artifact, path: "" })),
  scans: state.scans.map((scan) => ({ ...scan, artifact: { ...scan.artifact, path: "" } })),
});

let oidc: OidcVerifier | undefined;
export async function authenticateEnterpriseRequest(req: http.IncomingMessage): Promise<EnterpriseIdentity> {
  const gatewaySecret = process.env.LOAM_SAML_GATEWAY_KEY;
  const gatewayPayload = req.headers["x-loam-gateway-identity"];
  const gatewaySignature = req.headers["x-loam-gateway-signature"];
  if (gatewaySecret && typeof gatewayPayload === "string" && typeof gatewaySignature === "string") {
    const key = Buffer.from(gatewaySecret, "base64");
    if (key.length !== 32) throw new Error("SAML gateway key must decode to 32 bytes");
    return verifySamlGatewayIdentity(Buffer.from(gatewayPayload, "base64").toString("utf8"), gatewaySignature, key);
  }
  const issuer = process.env.LOAM_OIDC_ISSUER;
  const audience = process.env.LOAM_OIDC_AUDIENCE;
  if (issuer && audience) {
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) throw new Error("OIDC bearer token required");
    oidc ??= new OidcVerifier({ issuer, audience });
    return oidc.verify(authorization.slice(7));
  }
  const remote = req.socket.remoteAddress ?? "";
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"].includes(remote);
  if (process.env.LOAM_ENTERPRISE_REQUIRED === "true" || !loopback) throw new Error("OIDC or signed SAML gateway identity required");
  return localEnterpriseIdentity();
}

const objectBody = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  return value as Record<string, unknown>;
};
const string = (body: Record<string, unknown>, key: string): string => typeof body[key] === "string" ? String(body[key]).trim() : "";
const strings = (body: Record<string, unknown>, key: string): string[] => Array.isArray(body[key]) ? body[key].filter((value): value is string => typeof value === "string").slice(0, 100) : [];

export async function handleSecurityEnterpriseRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: SecurityEnterpriseRouteDeps): Promise<boolean> {
  const prefix = "/api/security/enterprise";
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
  res.setHeader("cache-control", "no-store");
  try {
    const identity = await (deps.identity ?? authenticateEnterpriseRequest)(req);
    if (req.method !== "GET") {
      const origin = req.headers.origin;
      if ((origin && origin !== `http://${req.headers.host}`) || req.headers["sec-fetch-site"] === "cross-site") {
        deps.sendJson(res, 403, { error: "same-origin requests required" });
        return true;
      }
      if (!req.headers["content-type"]?.startsWith("application/json")) {
        deps.sendJson(res, 415, { error: "application/json required" });
        return true;
      }
    }
    const parts = url.pathname.slice(prefix.length).split("/").filter(Boolean);
    const area = parts[0] ?? "";
    const body = req.method === "GET" ? {} : objectBody(await deps.readBody(req, 100_000));
    const requestedTenant = url.searchParams.get("tenantId") || string(body, "tenantId") || identity.tenantIds[0]!;
    const permit = (permission: Permission): void => requirePermission(identity, requestedTenant, permission);
    const store = new MobileEngagementStore(path.join(deps.workspace, ".loam", "mobile"));
    const sharedRoot = deps.dataRoot ?? defaultDataRoot();
    const sharedKill = new SharedKillSwitch(sharedRoot);
    configureSharedKillState(() => sharedKill.read().engaged);

    if (area === "health" && parts.length === 1 && req.method === "GET") {
      permit("engagement:read");
      const queue = new EnterpriseQueue(path.join(sharedRoot, "queue.sqlite"));
      const health = queue.health(requestedTenant);
      queue.close();
      return deps.sendJson(res, 200, { tenantId: requestedTenant, queue: health, killSwitch: sharedKill.read(), mobsfConfigured: Boolean(process.env.LOAM_MOBSF_URL && process.env.LOAM_MOBSF_API_KEY), identity: { id: identity.id, roles: identity.roles, authMethod: identity.authMethod } }), true;
    }
    if (area === "kill-switch" && parts.length === 1 && req.method === "POST") {
      const engage = body.engage === true;
      permit(engage ? "kill:engage" : "kill:reset");
      const state = sharedKill.set(engage, identity.id, typeof body.ttlSeconds === "number" ? Math.min(Math.max(body.ttlSeconds, 1), 3600) : undefined);
      if (engage) engageKillSwitch(); else resetKillSwitch();
      return deps.sendJson(res, 200, { state }), true;
    }
    if (area === "engagements" && parts.length === 1) {
      if (req.method === "GET") {
        permit("engagement:read");
        return deps.sendJson(res, 200, { engagements: store.list(requestedTenant).map(publicState) }), true;
      }
      if (req.method === "POST") {
        permit("engagement:create");
        const artifacts = await inventoryMobileArtifacts(deps.workspace);
        const state = store.create({ tenantId: requestedTenant, ownerId: identity.id, artifacts });
        return deps.sendJson(res, 201, { engagement: publicState(state) }), true;
      }
    }
    if (area === "engagements" && parts.length === 3) {
      const id = parts[1]!;
      const action = parts[2]!;
      permit(action === "authorize" ? "engagement:approve" : action === "coverage" || action === "qa" || action === "deliver" || action === "review-finding" || action === "retest" ? "finding:review" : action === "report" ? "report:read" : action === "start" || action === "scan" || action === "submit-qa" || action === "start-retest" ? "engagement:execute" : "engagement:read");
      const state = store.get(requestedTenant, id);
      if (req.method === "GET" && action === "report") {
        const cipher = configuredEvidenceCipher();
        const report = await buildProtectedMobileReport(state, path.join(deps.workspace, "mobile", id), cipher);
        const content = await readProtectedMobileMarkdown(report, state, cipher);
        return deps.sendJson(res, 200, { format: "markdown", encryptedAtRest: report.encrypted, content }), true;
      }
      if (req.method === "GET" && action === "status") return deps.sendJson(res, 200, { engagement: publicState(state) }), true;
      if (req.method !== "POST") return deps.sendJson(res, 405, { error: "method not allowed" }), true;
      if (action === "authorize") authorizeMobileEngagement(state, { id: string(body, "authorizationId"), statement: string(body, "statement"), expiresAt: string(body, "expiresAt"), approvedBy: identity.id });
      else if (action === "start") transitionMobileEngagement(state, "Running", identity.id);
      else if (action === "scan") {
        const baseUrl = process.env.LOAM_MOBSF_URL;
        const apiKey = process.env.LOAM_MOBSF_API_KEY;
        if (!baseUrl || !apiKey) return deps.sendJson(res, 503, { error: "MobSF is not configured" }), true;
        for (const result of await runMobileScan(state.artifacts, new MobSfClient({ baseUrl, apiKey }))) recordMobileScan(state, result);
      } else if (action === "coverage") {
        const current = state.coverage.find((entry) => entry.controlId === string(body, "controlId"));
        if (!current) return deps.sendJson(res, 400, { error: "unknown MASVS control" }), true;
        const status = string(body, "status") as MasvsStatus;
        if (!["covered", "partial", "not-tested", "not-applicable"].includes(status)) return deps.sendJson(res, 400, { error: "invalid MASVS status" }), true;
        setMobileCoverage(state, { ...current, status, applicable: body.applicable !== false, reason: string(body, "reason"), evidenceIds: strings(body, "evidenceIds") }, identity.id);
      } else if (action === "review-finding") reviewMobileFinding(state, string(body, "findingId"), identity.id);
      else if (action === "submit-qa") transitionMobileEngagement(state, "QA", identity.id);
      else if (action === "qa") reviewMobileQa(state, identity.id);
      else if (action === "deliver") transitionMobileEngagement(state, "Delivered", identity.id);
      else if (action === "start-retest") transitionMobileEngagement(state, "Retest", identity.id);
      else if (action === "retest") {
        const status = string(body, "status");
        if (!["fixed", "persistent", "inconclusive"].includes(status)) return deps.sendJson(res, 400, { error: "invalid retest status" }), true;
        recordMobileRetest(state, string(body, "findingId"), { status: status as "fixed" | "persistent" | "inconclusive", evidenceIds: strings(body, "evidenceIds"), reviewerId: identity.id, at: new Date().toISOString() });
      } else if (action === "close") {
        permit("finding:review");
        transitionMobileEngagement(state, "Closed", identity.id);
      } else return deps.sendJson(res, 404, { error: "unknown engagement action" }), true;
      store.update(state);
      let auditDelivery: "delivered" | "outbox" | "failed" | "not-configured" = "not-configured";
      const siem = configuredSiemExporter(sharedRoot, requestedTenant, id);
      if (siem) {
        try {
          const exported = await siem.export([{ seq: Date.now(), at: new Date().toISOString(), authzId: state.authorization?.id ?? null, capability: "mobile.engagement", action, target: `${requestedTenant}/${id}`, params: {}, outcome: "completed" }]);
          auditDelivery = exported.delivered ? "delivered" : "outbox";
        } catch {
          auditDelivery = "failed";
        }
      }
      return deps.sendJson(res, 200, { engagement: publicState(state), auditDelivery }), true;
    }
    return deps.sendJson(res, 404, { error: "enterprise endpoint not found" }), true;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    const status = /permission denied|tenant|identity|token|approval/.test(message) ? 403 : 400;
    deps.sendJson(res, status, { error: message });
    return true;
  }
}
