/** Cap G §4.15.2 — the /api/app-projects router. House style of planApproval.ts:
 *  JSON bodies, errors as {error:"<code>"}, Loam's own envelope (never Atoms').
 *  Every path parameter is validated (:id = app_ + 12 base32, :n positive int);
 *  file paths go through taskPath-style guards so .. and absolute paths refuse
 *  with 400. Handlers backed by the live modules are real; operations that need
 *  the multi-agent run engine (runs execution, edit sessions, publish, race
 *  choose) answer 501 engine_pending until that engine lands — the store, queue
 *  and events wiring around them is complete.
 *  Delta vs §4.15.2 (§0.1.8): one router file instead of nine per-area files. */
import type http from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAppProject, listAppProjects, updateAppProject, deleteAppProject, createAppProject } from "../../appbuilder/projects.js";
import { ensureAppBuilderSchema } from "../../appbuilder/store.js";
import { runPreflight } from "../../appbuilder/preflight.js";
import { queueState, enqueuePrompt, updateQueueItem, removeQueueItem, setQueuePaused } from "../../appbuilder/promptQueue.js";
import { raceEstimate } from "../../appbuilder/race.js";
import { appUsage } from "../../appbuilder/metering.js";
import { aiUsage, defaultProvider, setDefaultProvider, setProjectAi, projectAiConfig, testAiKey, checkBaseUrl } from "../../appbuilder/localCloud.js";
import { listRuntimeErrors, clearRuntimeErrors, fixPromptFor } from "../../appbuilder/runtimeErrors.js";
import { THEMES, applyTheme } from "../../appbuilder/themes.js";

const ID_RE = /^app_[a-z2-7]{12}$/;
const FILE_TREE_MAX = 5_000;
const FILE_VIEW_MAX_BYTES = 2 * 1024 * 1024;
const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".vite-cache"]);
const EXCLUDED_FILES = [/^\.env/, /\.sqlite(-wal|-shm)?$/];

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(data);
}

function readBody(req: http.IncomingMessage, maxBytes = 256 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("bad_request"));
      }
    });
    req.on("error", reject);
  });
}

/** Resolves an app-relative path inside <workspace>/app, refusing .. and absolute input. */
function appFile(project: { workspaceDir: string; appDir: string }, rel: string): string | null {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 400 || rel.includes("\\") || rel.includes("\0")) return null;
  if (path.isAbsolute(rel) || rel.split("/").includes("..")) return null;
  const base = path.resolve(project.workspaceDir, project.appDir);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

function listFiles(root: string, prefix = ""): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const walk = (dir: string, rel: string): void => {
    if (files.length >= FILE_TREE_MAX) { truncated = true; return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= FILE_TREE_MAX) { truncated = true; return; }
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (EXCLUDED_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), childRel);
      } else if (e.isFile()) {
        if (EXCLUDED_FILES.some((re) => re.test(e.name))) continue;
        files.push(prefix + childRel);
      }
    }
  };
  walk(root, "");
  return { files: files.sort(), truncated };
}

const enginePending = (res: http.ServerResponse): boolean => {
  sendJson(res, 501, { error: "engine_pending", message: "عملية التشغيل تحتاج محرك البناء — ستصلك في تحديث قادم" });
  return true;
};

/** Returns true when the request was handled. */
export async function handleAppBuilderRoutes(req: http.IncomingMessage, res: http.ServerResponse, p: string, url: URL): Promise<boolean> {
  if (!p.startsWith("/api/app-projects")) return false;
  ensureAppBuilderSchema();
  const segments = p.slice("/api/app-projects".length).split("/").filter(Boolean);
  const method = req.method ?? "GET";

  // ---- collection level ----
  if (segments.length === 0) {
    if (method === "GET") {
      const limitRaw = Number(url.searchParams.get("limit") ?? "50");
      const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 200 ? limitRaw : 50;
      return sendJson(res, 200, { projects: listAppProjects().slice(0, limit) }), true;
    }
    if (method === "POST") {
      const body = (await readBody(req)) as { title?: unknown; description?: unknown; features?: unknown; flavor?: unknown };
      if (typeof body.title !== "string" || !body.title.trim()) return sendJson(res, 400, { error: "bad_request", message: "title مطلوب" }), true;
      try {
        const project = createAppProject({
          title: body.title,
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          ...(Array.isArray(body.features) ? { features: body.features.filter((f): f is never => typeof f === "string") } : {}),
          ...(body.flavor === "quick" || body.flavor === "goal" ? { defaultFlavor: body.flavor } : {}),
          baseWorkspace: process.env.LOAM_WORKSPACE ?? process.cwd(),
        });
        return sendJson(res, 200, { project }), true;
      } catch (err) {
        return sendJson(res, 400, { error: "bad_request", message: err instanceof Error ? err.message : String(err) }), true;
      }
    }
    return sendJson(res, 405, { error: "bad_request" }), true;
  }

  if (segments[0] === "preflight" && method === "GET") return sendJson(res, 200, { preflight: await runPreflight() }), true;
  if (segments[0] === "ai-default") {
    if (method === "GET") return sendJson(res, 200, { provider: defaultProvider() }), true;
    if (method === "PUT") {
      const r = setDefaultProvider((await readBody(req)) as Record<string, unknown>);
      return sendJson(res, "error" in r ? 400 : 200, r), true;
    }
    return sendJson(res, 405, { error: "bad_request" }), true;
  }

  const id = segments[0]!;
  if (!ID_RE.test(id)) return sendJson(res, 400, { error: "bad_request", message: "معرّف مشروع غير صالح" }), true;
  const project = getAppProject(id);
  if (!project) return sendJson(res, 404, { error: "not_found" }), true;
  const sub = segments.slice(1);

  // ---- project level ----
  if (sub.length === 0) {
    if (method === "GET") return sendJson(res, 200, { project, devServer: null, queue: queueState(id) }), true;
    if (method === "PATCH") {
      const body = (await readBody(req)) as { title?: unknown; description?: unknown };
      const patch: Record<string, unknown> = {};
      if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim().slice(0, 80);
      if (typeof body.description === "string") patch.description = body.description.slice(0, 400);
      return sendJson(res, 200, { project: updateAppProject(id, patch) }), true;
    }
    if (method === "DELETE") {
      const body = (await readBody(req)) as { confirm?: unknown };
      if (body.confirm !== project.title) return sendJson(res, 400, { error: "bad_request", message: "confirm يجب أن يكون عنوان المشروع" }), true;
      deleteAppProject(id, true);
      return sendJson(res, 200, { ok: true }), true;
    }
    return sendJson(res, 405, { error: "bad_request" }), true;
  }

  const area = sub[0]!;

  // ---- queue ----
  if (area === "queue") {
    if (sub.length === 1) {
      if (method === "GET") return sendJson(res, 200, { queue: queueState(id) }), true;
      if (method === "POST") {
        const body = (await readBody(req)) as { content?: unknown; flavor?: unknown; attachments?: unknown };
        const flavor = body.flavor === "goal" ? "goal" : "quick";
        const r = enqueuePrompt(id, typeof body.content === "string" ? body.content : "", flavor, Array.isArray(body.attachments) ? (body.attachments as string[]) : []);
        return sendJson(res, "error" in r ? 409 : 200, "error" in r ? r : { item: r }), true;
      }
      return sendJson(res, 405, { error: "bad_request" }), true;
    }
    if (sub[1] === "pause" && method === "POST") return sendJson(res, 200, { queue: setQueuePaused(id, true) }), true;
    if (sub[1] === "resume" && method === "POST") return sendJson(res, 200, { queue: setQueuePaused(id, false) }), true;
    const itemId = sub[1]!;
    if (method === "PATCH") {
      const r = updateQueueItem(id, itemId, (await readBody(req)) as Record<string, unknown>);
      return sendJson(res, "error" in r ? 400 : 200, "error" in r ? r : { queue: r }), true;
    }
    if (method === "DELETE") {
      const r = removeQueueItem(id, itemId);
      return sendJson(res, "error" in r ? 400 : 200, "error" in r ? r : { queue: r }), true;
    }
    return sendJson(res, 405, { error: "bad_request" }), true;
  }

  // ---- races (estimate is real; choose/abort need the engine) ----
  if (area === "races") {
    if (sub.length === 1 && method === "GET") return enginePending(res);
    if (sub[1] === "estimate" && method === "GET") {
      const b = Number(url.searchParams.get("branches") ?? "2");
      const branches = b === 3 || b === 4 ? (b as 2 | 3 | 4) : 2;
      return sendJson(res, 200, { estimate: raceEstimate(id, branches) }), true;
    }
    return enginePending(res);
  }

  // ---- usage ----
  if (area === "usage" && method === "GET") {
    const runId = url.searchParams.get("runId") ?? undefined;
    return sendJson(res, 200, appUsage(id, runId || undefined)), true;
  }

  // ---- runtime errors ----
  if (area === "runtime-errors") {
    if (sub.length === 1 && method === "GET") {
      const limitRaw = Number(url.searchParams.get("limit") ?? "50");
      const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 200 ? limitRaw : 50;
      return sendJson(res, 200, { errors: listRuntimeErrors(id).slice(0, limit) }), true;
    }
    if (sub.length === 1 && method === "DELETE") { clearRuntimeErrors(id); return sendJson(res, 200, { ok: true }), true; }
    if (sub[1] === "fix-prompt" && method === "POST") {
      const errors = listRuntimeErrors(id);
      const ids = ((await readBody(req)) as { ids?: unknown }).ids;
      const picked = Array.isArray(ids) ? errors.filter((e) => ids.includes(e.id)) : errors;
      if (!picked.length) return sendJson(res, 404, { error: "not_found", message: "لا أخطاء متاحة" }), true;
      return sendJson(res, 200, { prompt: fixPromptFor(picked[0]!) }), true;
    }
    return sendJson(res, 405, { error: "bad_request" }), true;
  }

  // ---- design ----
  if (area === "design") {
    if (sub[1] === "theme" && method === "POST") {
      const themeId = ((await readBody(req)) as { themeId?: unknown }).themeId;
      if (typeof themeId !== "string" || !THEMES.some((t2) => t2.id === themeId)) return sendJson(res, 400, { error: "bad_request" }), true;
      try {
        applyTheme(path.join(project.workspaceDir, project.appDir), themeId as (typeof THEMES)[number]["id"]);
        return sendJson(res, 200, { ok: true }), true;
      } catch (err) {
        return sendJson(res, 400, { error: "bad_request", message: err instanceof Error ? err.message : String(err) }), true;
      }
    }
    if (sub[1] === "text-edit" && method === "POST") return enginePending(res);
    return sendJson(res, 404, { error: "not_found" }), true;
  }

  // ---- AI per project ----
  if (area === "ai") {
    if (sub.length === 1 && method === "GET") return sendJson(res, 200, { config: projectAiConfig(project) }), true;
    if (sub.length === 1 && method === "PUT") {
      const r = setProjectAi(id, (await readBody(req)) as Record<string, unknown>);
      return sendJson(res, "error" in r ? 400 : 200, r), true;
    }
    if (sub[1] === "test" && method === "POST") return sendJson(res, 200, await testAiKey(getAppProject(id)!)), true;
    if (sub[1] === "usage" && method === "GET") {
      const daysRaw = Number(url.searchParams.get("days") ?? "30");
      return sendJson(res, 200, { days: aiUsage(getAppProject(id)!, Number.isInteger(daysRaw) ? daysRaw : 30) }), true;
    }
    return sendJson(res, 405, { error: "bad_request" }), true;
  }

  // ---- files ----
  if (area === "files") {
    if (sub.length === 1 && method === "GET") {
      const tree = listFiles(path.join(project.workspaceDir, project.appDir));
      return sendJson(res, 200, { files: tree.files, truncated: tree.truncated }), true;
    }
    if (sub[1] === "view" && method === "GET") {
      const abs = appFile(project, url.searchParams.get("path") ?? "");
      if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return sendJson(res, 404, { error: "not_found" }), true;
      if (fs.statSync(abs).size > FILE_VIEW_MAX_BYTES) return sendJson(res, 413, { error: "too_large" }), true;
      const content = fs.readFileSync(abs, "utf8");
      return sendJson(res, 200, { content, sha1: createHash("sha1").update(content, "utf8").digest("hex") }), true;
    }
    if (sub.length === 1 && method === "PUT") {
      const body = (await readBody(req, 4 * 1024 * 1024)) as { path?: unknown; content?: unknown; baseSha1?: unknown };
      const abs = appFile(project, typeof body.path === "string" ? body.path : "");
      if (!abs) return sendJson(res, 400, { error: "bad_request", message: "مسار غير صالح" }), true;
      if (typeof body.content !== "string") return sendJson(res, 400, { error: "bad_request" }), true;
      const content = body.content;
      const sha1 = createHash("sha1").update(content, "utf8").digest("hex");
      if (fs.existsSync(abs)) {
        const disk = fs.readFileSync(abs, "utf8");
        const diskSha = createHash("sha1").update(disk, "utf8").digest("hex");
        if (typeof body.baseSha1 === "string" && body.baseSha1 !== diskSha) {
          return sendJson(res, 409, { error: "stale_file", message: "الملف تغيّر منذ فتحته — لا تُقرأ التغييرات فوق عمل الوكيل بصمت" }), true;
        }
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
      return sendJson(res, 200, { sha1 }), true;
    }
    return sendJson(res, 405, { error: "bad_request" }), true;
  }

  // ---- search ----
  if (area === "search" && method === "GET") {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) return sendJson(res, 400, { error: "bad_request", message: "q مطلوب" }), true;
    // Substring scan over the file tree, bounded (localGrep-style, no child process).
    const hits: Array<{ path: string; line: number; text: string }> = [];
    const { files } = listFiles(path.join(project.workspaceDir, project.appDir));
    const needle = q.toLowerCase();
    for (const rel of files) {
      if (hits.length >= 20) break;
      const abs = path.join(project.workspaceDir, project.appDir, rel);
      let text: string;
      try {
        if (fs.statSync(abs).size > 512 * 1024) continue;
        text = fs.readFileSync(abs, "utf8");
      } catch { continue; }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && hits.length < 20; i++) {
        if (lines[i]!.toLowerCase().includes(needle)) hits.push({ path: rel, line: i + 1, text: lines[i]!.trim().slice(0, 240) });
      }
    }
    return sendJson(res, 200, { hits }), true;
  }

  // ---- engine-bound areas (store wiring exists; execution lands with the engine) ----
  if (["runs", "questions", "plans", "assignments", "verify-reports", "versions", "edit-session", "dev-server", "db", "app-users", "export"].includes(area)) {
    return enginePending(res);
  }

  return sendJson(res, 404, { error: "not_found" }), true;
}
