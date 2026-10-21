/**
 * Routes for option 17/18/22 server additions (mounted as one module so the
 * supervisor adds a single import + dispatch line to http.ts; must be
 * dispatched BEFORE the generic /api/projects/ and /api/schedules/ handlers).
 *
 * - /api/model-tiers                     tier -> concrete model ids + Flex state
 * - /api/model-tiers/flex (PUT)          store BYOK config; key sealed, never echoed
 * - /api/model-tiers/flex/key (DELETE)   remove the stored Flex key
 * - /api/projects/:id/git                real branch of the project folder
 * - /api/projects/:id/folder (PUT)       set/clear the project folder
 * - /api/projects/:id/worktrees (POST)   git worktree add under the project dir
 * - /api/schedules/:id (PATCH)           edit routine prompt / enabled (option 22)
 */
import http from "node:http";
import fs from "node:fs";
import { MODEL_TIERS, flexConfig, resolveTierModel, setFlexConfig, clearFlexKey } from "../modelTiers.js";
import { readGitBranch, createWorktree } from "../worktrees.js";
import { getProject, updateProject, getSchedule, updateSchedule } from "../db.js";
import { loadConfig } from "../../config.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 64_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try { resolve(JSON.parse(text) as Record<string, unknown>); } catch (err) { reject(new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`)); }
    });
    req.on("error", reject);
  });
}

export async function handleProjectContextRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  // ---- model tiers (option 18) ----
  if (p === "/api/model-tiers" && req.method === "GET") {
    const cfg = loadConfig();
    const tiers = MODEL_TIERS.map((id) => {
      const r = resolveTierModel(cfg, id);
      return { id, model: r.model, flex: r.flex };
    });
    sendJson(res, 200, { tiers, flex: flexConfig() });
    return true;
  }
  if (p === "/api/model-tiers/flex" && req.method === "PUT") {
    let body: Record<string, unknown>;
    try { body = await readJson(req); } catch (err) { return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }), true; }
    const result = setFlexConfig(body);
    if ("error" in result) sendJson(res, 400, result);
    else sendJson(res, 200, result);
    return true;
  }
  if (p === "/api/model-tiers/flex/key" && req.method === "DELETE") {
    sendJson(res, 200, { cleared: clearFlexKey(), flex: flexConfig() });
    return true;
  }

  // ---- project context (option 17) ----
  const projectMatch = /^\/api\/projects\/([^\/]+)\/(git|folder|worktrees)$/.exec(p);
  if (projectMatch) {
    const id = decodeURIComponent(projectMatch[1]!);
    const sub = projectMatch[2]!;
    const project = getProject(id);
    if (!project) { sendJson(res, 404, { error: "project not found" }); return true; }
    if (sub === "git" && req.method === "GET") {
      if (!project.folder) { sendJson(res, 200, { isGit: false, branch: null, reason: "no folder set for this project" }); return true; }
      sendJson(res, 200, { folder: project.folder, ...(await readGitBranch(project.folder)) });
      return true;
    }
    if (sub === "folder" && req.method === "PUT") {
      let body: Record<string, unknown>;
      try { body = await readJson(req); } catch (err) { return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }), true; }
      const folder = typeof body.path === "string" ? body.path.trim() : "";
      if (folder && (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory())) { sendJson(res, 400, { error: "path is not an existing directory" }); return true; }
      const updated = updateProject(id, { folder });
      sendJson(res, 200, { project: updated });
      return true;
    }
    if (sub === "worktrees" && req.method === "POST") {
      if (!project.folder) { sendJson(res, 400, { error: "project has no folder" }); return true; }
      let body: Record<string, unknown>;
      try { body = await readJson(req); } catch (err) { return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }), true; }
      const result = await createWorktree(project.folder, body.name);
      if ("error" in result) sendJson(res, 409, result);
      else sendJson(res, 201, result);
      return true;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  // ---- routine editing (option 22) ----
  const scheduleMatch = /^\/api\/schedules\/([^\/]+)$/.exec(p);
  if (scheduleMatch && req.method === "PATCH") {
    const id = decodeURIComponent(scheduleMatch[1]!);
    if (!getSchedule(id)) { sendJson(res, 404, { error: "schedule not found" }); return true; }
    let body: Record<string, unknown>;
    try { body = await readJson(req); } catch (err) { return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }), true; }
    const patch: { prompt?: string; enabled?: boolean } = {};
    if (typeof body.prompt === "string") patch.prompt = body.prompt;
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    const schedule = updateSchedule(id, patch);
    sendJson(res, 200, { schedule });
    return true;
  }

  return false;
}
