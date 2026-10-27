import type http from "node:http";
import { ENGINE_MANIFESTS } from "../security/engines/registry.js";
import { runEngineWorker, type EngineExec } from "../security/engines/worker.js";
import { loadAuthorization, defaultDataRoot } from "../security/red/gate.js";
import { requirePermission } from "../security/enterprise/policy.js";
import { authenticateEnterpriseRequest, type SecurityEnterpriseRouteDeps } from "./securityEnterpriseRoutes.js";

const text = (body: Record<string, unknown>, key: string): string => typeof body[key] === "string" ? String(body[key]).trim() : "";
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  return value as Record<string, unknown>;
};

export async function handleEngineRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: SecurityEnterpriseRouteDeps & { engineExec?: EngineExec }): Promise<boolean> {
  const prefix = "/api/security/engines";
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
  res.setHeader("cache-control", "no-store");
  try {
    const identity = await (deps.identity ?? authenticateEnterpriseRequest)(req);
    const tenantId = url.searchParams.get("tenantId") || identity.tenantIds[0]!;
    const area = url.pathname.slice(prefix.length).split("/").filter(Boolean)[0] ?? "";
    if (req.method === "GET" && area === "") {
      requirePermission(identity, tenantId, "engagement:read");
      deps.sendJson(res, 200, { engines: ENGINE_MANIFESTS.map((manifest) => ({ ...manifest, configured: manifest.executableEnv ? Boolean(process.env[manifest.executableEnv] && process.env[manifest.sha256Env!]) : true })) });
      return true;
    }
    if (req.method === "POST" && area === "worker") {
      if ((req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || req.headers["sec-fetch-site"] === "cross-site") return deps.sendJson(res, 403, { error: "same-origin requests required" }), true;
      if (!req.headers["content-type"]?.startsWith("application/json")) return deps.sendJson(res, 415, { error: "application/json required" }), true;
      const body = object(await deps.readBody(req, 100_000));
      requirePermission(identity, tenantId, "engagement:execute");
      const authz = loadAuthorization(text(body, "authorizationId"), deps.dataRoot ?? defaultDataRoot());
      if (!authz) return deps.sendJson(res, 403, { error: "signed authorization is unavailable" }), true;
      const result = await runEngineWorker({
        engineId: text(body, "engineId"),
        commandId: text(body, "commandId"),
        authz,
        scopeTarget: text(body, "scopeTarget"),
        target: text(body, "target"),
        ...(text(body, "program") ? { program: text(body, "program") } : {}),
        workspace: deps.workspace,
        licenseReviewed: body.licenseReviewed === true,
        ...(deps.engineExec ? { exec: deps.engineExec } : {}),
      });
      deps.sendJson(res, result.status === "covered" ? 200 : result.status === "partial" || result.status === "error" ? 422 : 503, { result });
      return true;
    }
    deps.sendJson(res, 404, { error: "engine endpoint not found" });
    return true;
  } catch (error) {
    deps.sendJson(res, 400, { error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
    return true;
  }
}
