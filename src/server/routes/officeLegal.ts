import http from "node:http";
import { requireTaskWorkspace } from "../taskWorkspace.js";
import { localOfficeIdentity, requireOfficeAccess, type OfficeIdentity } from "../../office/intelligence/authorization.js";
import { OfficeIntelligenceError, isRecord, parseArtifactRef, type OfficeScope } from "../../office/intelligence/contracts.js";
import { deleteLegalSource, getLegalSource, listLegalSources, registerLegalSource, searchLegalSources } from "../../office/intelligence/legal/sources.js";
import { attachMatterArtifact, checkMatterConflicts, createMatter, getMatter, listMatters, matterDashboard, searchMatterArchive, updateMatter, type MatterRecord } from "../../office/intelligence/legal/matters.js";

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
      if (size > maxBytes) { reject(new OfficeIntelligenceError("request body is too large", 413, "body_too_large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new OfficeIntelligenceError("invalid JSON body", 400, "invalid_json")); }
    });
    req.on("error", reject);
  });
}

function scope(url: URL, value?: unknown): OfficeScope {
  const body = isRecord(value) ? value : {};
  const tenantId = url.searchParams.get("tenantId") ?? (typeof body.tenantId === "string" ? body.tenantId : "local");
  const projectId = url.searchParams.get("projectId") ?? (typeof body.projectId === "string" ? body.projectId : undefined);
  const matterId = url.searchParams.get("matterId") ?? (typeof body.matterId === "string" ? body.matterId : undefined);
  return { tenantId, ...(projectId ? { projectId } : {}), ...(matterId ? { matterId } : {}) };
}

function matterScope(matter: MatterRecord): OfficeScope {
  return { tenantId: matter.tenantId, ...(matter.projectId ? { projectId: matter.projectId } : {}), matterId: matter.id };
}

export interface OfficeLegalRouteContext {
  workspace: string;
  identity?: OfficeIdentity;
}

export async function handleOfficeLegalRoutes(req: http.IncomingMessage, res: http.ServerResponse, p: string, ctx: OfficeLegalRouteContext): Promise<boolean> {
  if (!p.startsWith("/api/office/legal")) return false;
  const identity = ctx.identity ?? localOfficeIdentity();
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  try {
    if (p === "/api/office/legal/sources" && req.method === "GET") {
      const access = scope(url);
      requireOfficeAccess(identity, access, "office:read");
      sendJson(res, 200, { sources: listLegalSources(access) });
      return true;
    }
    if (p === "/api/office/legal/sources" && req.method === "POST") {
      const body = await readJson(req);
      const access = scope(url, body);
      requireOfficeAccess(identity, access, "office:connector");
      const source = registerLegalSource(body);
      sendJson(res, 201, { source });
      return true;
    }
    if (p === "/api/office/legal/sources/search" && req.method === "GET") {
      const access = scope(url);
      requireOfficeAccess(identity, access, "office:read");
      const sources = searchLegalSources(access, url.searchParams.get("query") ?? "", { limit: Number(url.searchParams.get("limit") ?? 8) });
      sendJson(res, 200, { sources });
      return true;
    }
    const sourceMatch = /^\/api\/office\/legal\/sources\/([^/]+)$/.exec(p);
    if (sourceMatch && req.method === "DELETE") {
      const source = getLegalSource(decodeURIComponent(sourceMatch[1]!));
      if (!source) throw new OfficeIntelligenceError("legal source not found", 404, "source_not_found");
      requireOfficeAccess(identity, { tenantId: source.tenantId, ...(source.projectId ? { projectId: source.projectId } : {}), ...(source.matterId ? { matterId: source.matterId } : {}) }, "office:connector");
      deleteLegalSource(source.id, Number(url.searchParams.get("expectedRevision")));
      sendJson(res, 200, { deleted: true });
      return true;
    }
    if (p === "/api/office/legal/matters" && req.method === "GET") {
      const access = scope(url);
      requireOfficeAccess(identity, access, "office:read");
      sendJson(res, 200, { matters: listMatters(access) });
      return true;
    }
    if (p === "/api/office/legal/matters" && req.method === "POST") {
      const body = await readJson(req);
      requireOfficeAccess(identity, scope(url, body), "office:write");
      const matter = createMatter(body);
      sendJson(res, 201, { matter });
      return true;
    }
    if (p === "/api/office/legal/matters/search" && req.method === "GET") {
      const access = scope(url);
      requireOfficeAccess(identity, access, "office:read");
      const result = await searchMatterArchive(access, url.searchParams.get("query") ?? "", (taskId) => requireTaskWorkspace(taskId, ctx.workspace));
      sendJson(res, 200, result);
      return true;
    }
    const match = /^\/api\/office\/legal\/matters\/([^/]+)(?:\/(conflicts|dashboard|artifacts))?$/.exec(p);
    if (match) {
      const matter = getMatter(decodeURIComponent(match[1]!));
      const access = matterScope(matter);
      const action = match[2];
      requireOfficeAccess(identity, access, action === "artifacts" ? "office:write" : "office:read");
      if (!action && req.method === "GET") {
        sendJson(res, 200, { matter });
        return true;
      }
      if (!action && req.method === "PUT") {
        const body = await readJson(req);
        if (!isRecord(body)) throw new OfficeIntelligenceError("matter patch is required", 422, "invalid_matter");
        sendJson(res, 200, { matter: updateMatter(matter.id, Number(body.expectedRevision), body.patch) });
        return true;
      }
      if (action === "conflicts" && req.method === "GET") {
        sendJson(res, 200, { candidates: checkMatterConflicts(matter.id), requiresHumanReview: true });
        return true;
      }
      if (action === "dashboard" && req.method === "GET") {
        sendJson(res, 200, { dashboard: matterDashboard(matter.id) });
        return true;
      }
      if (action === "artifacts" && req.method === "POST") {
        const body = await readJson(req);
        if (!isRecord(body)) throw new OfficeIntelligenceError("artifact body is required", 422, "invalid_matter");
        const ref = parseArtifactRef(body.artifact);
        const workspace = requireTaskWorkspace(ref.taskId, ctx.workspace);
        const { readOfficeArtifact } = await import("../../office/intelligence/artifactIO.js");
        await readOfficeArtifact(workspace, ref);
        sendJson(res, 200, { matter: attachMatterArtifact(matter.id, ref, Number(body.expectedRevision)) });
        return true;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    sendJson(res, 404, { error: "Office legal route not found" });
    return true;
  } catch (error) {
    if (error instanceof OfficeIntelligenceError) sendJson(res, error.status, { error: error.message, code: error.code });
    else {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, /task not found/.test(message) ? 404 : /outside task workspace|links are not allowed/.test(message) ? 400 : 500, { error: message });
    }
    return true;
  }
}
