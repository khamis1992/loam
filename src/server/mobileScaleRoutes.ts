import path from "node:path";
import type http from "node:http";
import { EvidenceTimeline } from "../security/mobile/evidenceTimeline.js";
import { MobileDeviceFarm, type FarmDevice } from "../security/mobile/farm.js";
import { MobileEngagementStore } from "../security/mobile/engagement.js";
import { buildInvestigation } from "../security/mobile/investigation.js";
import { buildAttackPaths } from "../security/mobile/attackPath.js";
import { replayMobileRequest } from "../security/mobile/replay.js";
import { loadAuthorization } from "../security/red/gate.js";
import { redTransport } from "../security/red/transport.js";
import { configuredEvidenceCipher } from "../security/enterprise/runtime.js";
import { GitHubIntegration, IntegrationDedupeStore, JiraIntegration, SlackIntegration } from "../security/enterprise/integrations.js";
import { EnterpriseQueue } from "../security/enterprise/queue.js";
import { evaluateSlo } from "../security/enterprise/slo.js";
import { defaultDataRoot } from "../security/red/gate.js";
import { requirePermission } from "../security/enterprise/policy.js";
import { authenticateEnterpriseRequest, type SecurityEnterpriseRouteDeps } from "./securityEnterpriseRoutes.js";

const text = (body: Record<string, unknown>, key: string): string => typeof body[key] === "string" ? String(body[key]).trim() : "";
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  return value as Record<string, unknown>;
};
const publicDevice = (device: FarmDevice, tenantId: string): Partial<FarmDevice> => ({
  id: device.id,
  platform: device.platform,
  osVersion: device.osVersion,
  capabilities: device.capabilities,
  workerVersion: device.workerVersion,
  imageDigest: device.imageDigest,
  health: device.health,
  ...(device.leaseTenantId === tenantId ? { leaseTenantId: device.leaseTenantId, leaseEngagementId: device.leaseEngagementId, leaseUntil: device.leaseUntil } : {}),
});

export async function handleMobileScaleRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: SecurityEnterpriseRouteDeps): Promise<boolean> {
  const prefix = "/api/security/mobile-scale";
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
  res.setHeader("cache-control", "no-store");
  let farm: MobileDeviceFarm | undefined;
  try {
    const identity = await (deps.identity ?? authenticateEnterpriseRequest)(req);
    if (req.method !== "GET" && ((req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || req.headers["sec-fetch-site"] === "cross-site")) {
      deps.sendJson(res, 403, { error: "same-origin requests required" });
      return true;
    }
    if (req.method !== "GET" && !req.headers["content-type"]?.startsWith("application/json")) {
      deps.sendJson(res, 415, { error: "application/json required" });
      return true;
    }
    const body = req.method === "GET" ? {} : object(await deps.readBody(req, 200_000));
    const tenantId = url.searchParams.get("tenantId") || text(body, "tenantId") || identity.tenantIds[0]!;
    const root = deps.dataRoot ?? defaultDataRoot();
    farm = new MobileDeviceFarm(path.join(root, "mobile-farm.sqlite"));
    const store = new MobileEngagementStore(path.join(deps.workspace, ".loam", "mobile"));
    const timeline = new EvidenceTimeline(path.join(root, "timeline"), configuredEvidenceCipher() ?? undefined);
    const parts = url.pathname.slice(prefix.length).split("/").filter(Boolean);
    const area = parts[0] ?? "";

    if (area === "devices") {
      if (parts.length === 1 && req.method === "GET") {
        requirePermission(identity, tenantId, "engagement:read");
        return deps.sendJson(res, 200, { devices: farm.list().map((device) => publicDevice(device, tenantId)) }), true;
      }
      if (parts.length === 1 && req.method === "POST") {
        requirePermission(identity, tenantId, "admin:write");
        const device: FarmDevice = { id: text(body, "id"), platform: text(body, "platform") as "android" | "ios", osVersion: text(body, "osVersion"), capabilities: Array.isArray(body.capabilities) ? body.capabilities.filter((value): value is string => typeof value === "string") : [], workerVersion: text(body, "workerVersion"), imageDigest: text(body, "imageDigest"), health: "healthy" };
        if (!["android", "ios"].includes(device.platform)) throw new Error("invalid device platform");
        farm.register(device);
        return deps.sendJson(res, 201, { device: publicDevice(farm.get(device.id), tenantId) }), true;
      }
      if (parts.length === 2 && parts[1] === "lease" && req.method === "POST") {
        requirePermission(identity, tenantId, "engagement:execute");
        const engagementId = text(body, "engagementId");
        store.get(tenantId, engagementId);
        const device = farm.lease(tenantId, engagementId, { platform: text(body, "platform") as "android" | "ios", ...(text(body, "osVersion") ? { osVersion: text(body, "osVersion") } : {}), capabilities: Array.isArray(body.capabilities) ? body.capabilities.filter((value): value is string => typeof value === "string") : [] });
        if (!device) return deps.sendJson(res, 503, { error: "no healthy device matches the requirement" }), true;
        return deps.sendJson(res, 200, { device: publicDevice(device, tenantId) }), true;
      }
      if (parts.length === 3 && parts[2] === "release" && req.method === "POST") {
        requirePermission(identity, tenantId, "engagement:execute");
        const device = farm.release(tenantId, text(body, "engagementId"), parts[1]!, { success: body.success === true, evidenceSha256: text(body, "evidenceSha256") });
        return deps.sendJson(res, 200, { device: publicDevice(device, tenantId) }), true;
      }
      if (parts.length === 3 && parts[2] === "quarantine" && req.method === "POST") {
        requirePermission(identity, tenantId, "admin:write");
        farm.quarantine(parts[1]!);
        return deps.sendJson(res, 200, { device: publicDevice(farm.get(parts[1]!), tenantId) }), true;
      }
    }

    if (area === "slo" && req.method === "GET") {
      requirePermission(identity, tenantId, "engagement:read");
      const queue = new EnterpriseQueue(path.join(root, "queue.sqlite"));
      const health = queue.health(tenantId);
      queue.close();
      const jobs = Object.entries(health).flatMap(([status, count]) => Array.from({ length: count }, () => ({ status: status === "completed" ? "completed" as const : status === "dead" ? "dead" as const : status === "queued" ? "queued" as const : "failed" as const, queueWaitMs: 0 })));
      const engagements = store.list(tenantId);
      const unknownCoverage = engagements.reduce((total, state) => total + state.coverage.filter((entry) => entry.applicable && entry.status !== "covered").length, 0);
      return deps.sendJson(res, 200, { ...evaluateSlo(jobs, unknownCoverage, 0), queueWaitMeasured: false, note: "Queue wait requires worker timestamps; zero is not asserted as measured latency" }), true;
    }

    if (["timeline", "investigation", "attack-path", "replay", "integrations"].includes(area) && parts.length === 2) {
      const engagementId = parts[1]!;
      const state = store.get(tenantId, engagementId);
      if (req.method === "GET") requirePermission(identity, tenantId, "engagement:read");
      else requirePermission(identity, tenantId, area === "integrations" ? "engagement:execute" : area === "attack-path" ? "finding:review" : "engagement:execute");
      if (area === "timeline") {
        if (req.method === "GET") {
          const events = await timeline.list(tenantId, engagementId);
          return deps.sendJson(res, 200, { events: events.map(({ encrypted: _encrypted, ...event }) => event) }), true;
        }
        const relatedFindingIds = Array.isArray(body.relatedFindingIds) ? body.relatedFindingIds.filter((value): value is string => typeof value === "string") : [];
        if (relatedFindingIds.some((id) => !state.findings.some((finding) => finding.id === id))) throw new Error("timeline finding reference is outside the engagement");
        const event = await timeline.append(tenantId, engagementId, { kind: text(body, "kind") as "request", summary: text(body, "summary"), content: text(body, "content"), relatedFindingIds, ...(text(body, "artifactSha256") ? { artifactSha256: text(body, "artifactSha256") } : {}) });
        const { encrypted: _encrypted, ...safe } = event;
        return deps.sendJson(res, 201, { event: safe }), true;
      }
      if (area === "investigation" && req.method === "GET") return deps.sendJson(res, 200, buildInvestigation(state, await timeline.list(tenantId, engagementId))), true;
      if (area === "attack-path" && req.method === "POST") {
        const nodes = Array.isArray(body.nodes) ? body.nodes : [];
        const edges = Array.isArray(body.edges) ? body.edges : [];
        const knownEvidence = new Set((await timeline.list(tenantId, engagementId)).map((event) => event.id));
        for (const edge of edges) {
          const evidence = (edge as { evidenceIds?: unknown }).evidenceIds;
          if (!Array.isArray(evidence) || evidence.some((id) => typeof id !== "string" || !knownEvidence.has(id))) throw new Error("attack path evidence is outside the engagement");
        }
        return deps.sendJson(res, 200, { paths: buildAttackPaths(nodes as never, edges as never) }), true;
      }
      if (area === "replay" && req.method === "POST") {
        if (!state.authorization) throw new Error("engagement authorization is missing");
        const authz = loadAuthorization(state.authorization.id, root);
        if (!authz) throw new Error("signed replay authorization is unavailable");
        const headers: Record<string, string> = {};
        if (body.headers && typeof body.headers === "object" && !Array.isArray(body.headers)) {
          for (const [key, value] of Object.entries(body.headers).slice(0, 10)) if (typeof value === "string") headers[key.toLowerCase()] = value;
        }
        const origin = new URL(text(body, "url")).origin;
        const transport = redTransport(authz, { ...(Object.keys(headers).length ? { authHeaders: headers, authOrigin: origin } : {}) });
        const result = await replayMobileRequest(authz, transport, { url: text(body, "url"), ...(body.expectedStatus === undefined ? {} : { expectedStatus: Number(body.expectedStatus) }), ...(text(body, "expectedMarker") ? { expectedMarker: text(body, "expectedMarker") } : {}) });
        return deps.sendJson(res, 200, { result }), true;
      }
      if (area === "integrations" && req.method === "POST") {
        const target = text(body, "target");
        const findingId = text(body, "findingId");
        const finding = state.findings.find((item) => item.id === findingId);
        if (!finding) throw new Error("finding not found");
        const dedupe = new IntegrationDedupeStore(path.join(root, "integration-dedupe"));
        if (!dedupe.claim(tenantId, findingId, target)) return deps.sendJson(res, 409, { error: "finding was already delivered to this integration" }), true;
        if (target === "jira") {
          const integration = new JiraIntegration({ baseUrl: process.env.LOAM_JIRA_URL ?? "", project: process.env.LOAM_JIRA_PROJECT ?? "", token: process.env.LOAM_JIRA_TOKEN ?? "", allowedHosts: (process.env.LOAM_JIRA_ALLOWED_HOSTS ?? "").split(",").filter(Boolean) });
          return deps.sendJson(res, 200, { result: await integration.createFinding({ findingId, title: finding.title, description: finding.detail }) }), true;
        }
        if (target === "github") {
          const integration = new GitHubIntegration({ owner: process.env.LOAM_GITHUB_OWNER ?? "", repo: process.env.LOAM_GITHUB_REPO ?? "", token: process.env.LOAM_GITHUB_TOKEN ?? "", ...(process.env.LOAM_GITHUB_URL ? { baseUrl: process.env.LOAM_GITHUB_URL } : {}) });
          return deps.sendJson(res, 200, { result: await integration.createFinding({ findingId, title: finding.title, description: finding.detail }) }), true;
        }
        if (target === "slack") {
          await new SlackIntegration({ webhookUrl: process.env.LOAM_SLACK_WEBHOOK ?? "" }).notify(`[${finding.severity}] ${finding.title} — ${state.id}`);
          return deps.sendJson(res, 200, { result: { delivered: true } }), true;
        }
        throw new Error("unknown integration target");
      }
    }
    return deps.sendJson(res, 404, { error: "mobile scale endpoint not found" }), true;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    deps.sendJson(res, /permission denied|tenant|identity|token|authorization/.test(message) ? 403 : 400, { error: message });
    return true;
  } finally {
    farm?.close();
  }
}
