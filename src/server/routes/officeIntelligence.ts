import http from "node:http";
import type { Config } from "../../config.js";
import type { OllamaClient } from "../../ollama.js";
import { requireTaskWorkspace } from "../taskWorkspace.js";
import { loadOfficeArtifact, saveOfficeChangeSet } from "../../office/intelligence/artifactIO.js";
import { assertSameActor, canAccessOfficeScope, localOfficeIdentity, requireOfficeAccess, type OfficeIdentity } from "../../office/intelligence/authorization.js";
import { cancelOfficeRun, getOfficeRun, listOfficeRuns, startOfficeRun } from "../../office/intelligence/service.js";
import { createOfficeModelGateway } from "../../office/intelligence/modelGateway.js";
import { assertCapabilityMatchesArtifact, OFFICE_CAPABILITIES, OfficeIntelligenceError, isRecord, parseStartOfficeRunInput, type OfficeScope } from "../../office/intelligence/contracts.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req: http.IncomingMessage, maxBytes = 2_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new OfficeIntelligenceError("request body is too large", 413, "body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new OfficeIntelligenceError("invalid JSON body", 400, "invalid_json")); }
    });
    req.on("error", reject);
  });
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500) throw new OfficeIntelligenceError(`${name} is required`, 422, "invalid_contract");
  return value;
}

function scopeFrom(url: URL, body?: unknown): OfficeScope {
  const record = isRecord(body) && isRecord(body.scope) ? body.scope : {};
  return {
    tenantId: string(url.searchParams.get("tenantId") ?? record.tenantId ?? "local", "tenantId"),
    ...(url.searchParams.get("projectId") || record.projectId ? { projectId: string(url.searchParams.get("projectId") ?? record.projectId, "projectId") } : {}),
    ...(url.searchParams.get("matterId") || record.matterId ? { matterId: string(url.searchParams.get("matterId") ?? record.matterId, "matterId") } : {}),
  };
}

export interface OfficeIntelligenceRouteContext {
  workspace: string;
  cfg: Config;
  ollama: OllamaClient;
  identity?: OfficeIdentity;
}

export async function handleOfficeIntelligenceRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx: OfficeIntelligenceRouteContext,
): Promise<boolean> {
  if (!p.startsWith("/api/office/intelligence")) return false;
  const identity = ctx.identity ?? localOfficeIdentity();
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  try {
    if (p === "/api/office/intelligence/capabilities" && req.method === "GET") {
      requireOfficeAccess(identity, scopeFrom(url), "office:read");
      sendJson(res, 200, { capabilities: OFFICE_CAPABILITIES });
      return true;
    }
    if (p === "/api/office/intelligence/artifacts/describe" && req.method === "POST") {
      const body = await readJson(req);
      if (!isRecord(body)) throw new OfficeIntelligenceError("request body is required", 422, "invalid_contract");
      const scope = scopeFrom(url, body);
      requireOfficeAccess(identity, scope, "office:read");
      const taskId = string(body.taskId, "taskId");
      const kind = string(body.kind, "kind");
      if (kind !== "document" && kind !== "spreadsheet" && kind !== "presentation") throw new OfficeIntelligenceError("unsupported artifact kind", 422, "invalid_contract");
      const workspace = requireTaskWorkspace(taskId, ctx.workspace);
      const loaded = await loadOfficeArtifact(workspace, { taskId, path: string(body.path, "path"), kind, tenantId: scope.tenantId });
      sendJson(res, 200, { artifact: loaded.ref, sources: loaded.artifact.warnings ?? [] });
      return true;
    }
    if (p === "/api/office/intelligence/runs" && req.method === "POST") {
      const body = await readJson(req);
      const input = parseStartOfficeRunInput(body, identity.id);
      assertSameActor(identity, input.actorId);
      if (input.artifact.tenantId !== input.scope.tenantId || input.artifact.taskId.length === 0) throw new OfficeIntelligenceError("artifact and scope tenants must match", 403, "scope_denied");
      requireOfficeAccess(identity, input.scope, "office:ai");
      assertCapabilityMatchesArtifact(input.capability, input.artifact.kind);
      const workspace = requireTaskWorkspace(input.artifact.taskId, ctx.workspace);
      const run = startOfficeRun(input, { workspace, model: createOfficeModelGateway(ctx.cfg, ctx.ollama) });
      sendJson(res, 202, { run });
      return true;
    }
    if (p === "/api/office/intelligence/runs" && req.method === "GET") {
      const scope = scopeFrom(url);
      requireOfficeAccess(identity, scope, "office:read");
      const privileged = identity.roles.includes("admin") || identity.roles.includes("partner");
      const runs = listOfficeRuns({ taskId: url.searchParams.get("taskId") ?? undefined, limit: Number(url.searchParams.get("limit") ?? 50) })
        .filter((run) => canAccessOfficeScope(identity, run.scope) && (privileged || run.actorId === identity.id));
      sendJson(res, 200, { runs });
      return true;
    }
    const match = /^\/api\/office\/intelligence\/runs\/([^/]+)(?:\/(apply|cancel))?$/.exec(p);
    if (match) {
      const id = decodeURIComponent(match[1]!);
      const action = match[2];
      const run = getOfficeRun(id);
      requireOfficeAccess(identity, run.scope, action === "apply" ? "office:write" : "office:read");
      if (action === "apply" && req.method === "POST") {
        requireOfficeAccess(identity, run.scope, "office:approve");
        if (run.status !== "succeeded" || !run.result?.changeSet) throw new OfficeIntelligenceError("run has no applicable change set", 409, "changeset_unavailable");
        const workspace = requireTaskWorkspace(run.artifact.taskId, ctx.workspace);
        const saved = await saveOfficeChangeSet(workspace, run.result.changeSet);
        sendJson(res, 200, { saved, run: getOfficeRun(id) });
        return true;
      }
      if (action === "cancel" && req.method === "POST") {
        if (run.actorId !== identity.id && !identity.roles.includes("admin")) throw new OfficeIntelligenceError("only the run owner can cancel it", 403, "actor_mismatch");
        sendJson(res, 200, { run: cancelOfficeRun(id) });
        return true;
      }
      if (!action && req.method === "GET") {
        sendJson(res, 200, { run });
        return true;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    sendJson(res, 404, { error: "Office intelligence route not found" });
    return true;
  } catch (error) {
    if (error instanceof OfficeIntelligenceError) {
      sendJson(res, error.status, { error: error.message, code: error.code });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      const status = /task not found/.test(message) ? 404 : /outside task workspace|links are not allowed|path outside/.test(message) ? 400 : 500;
      sendJson(res, status, { error: message });
    }
    return true;
  }
}
