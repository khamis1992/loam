/** Cap G §4.15.2 — the /api/app-projects router. House style of planApproval.ts:
 *  JSON bodies, errors as {error:"<code>"}, Loam's own envelope (never Atoms').
 *  Every path parameter is validated (:id = app_ + 12 base32, :n positive int);
 *  file paths go through taskPath-style guards so .. and absolute paths refuse
 *  with 400.
 *  W3-c: every engine-bound area is real — runs start/stop through the
 *  AppRunEngine (executionQueue lock app:<projectId>, prompt-queue fallback),
 *  questions/plans resume the parked run, versions use the VersionService,
 *  edit sessions commit/discard, races start via POST /runs and choose/abort
 *  through the RaceEngine. The only 501s left are §4.7.7/§4.7.8 (publish,
 *  security-scan) and §4.9/§4.10 (export, db, app-users), which are later-wave
 *  surfaces, not run-engine contracts.
 *  Delta vs §4.15.2 (§0.1.8): one router file instead of nine per-area files. */
import type http from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAppProject, listAppProjects, updateAppProject, deleteAppProject, createAppProject } from "../../appbuilder/projects.js";
import {
  ensureAppBuilderSchema, listAssignments, listPlanDrafts, listRaces, listVersions,
  listVerifyReports, updateVersionRow, listForksOf, activeRaceFor, getRun, updateAppProjectRow,
} from "../../appbuilder/store.js";
import { runPreflight } from "../../appbuilder/preflight.js";
import { queueState, enqueuePrompt, updateQueueItem, removeQueueItem, setQueuePaused } from "../../appbuilder/promptQueue.js";
import { raceEstimate } from "../../appbuilder/race.js";
import { appUsage } from "../../appbuilder/metering.js";
import { aiUsage, defaultProvider, setDefaultProvider, setProjectAi, projectAiConfig, testAiKey, stripeStatus, setAppStripe } from "../../appbuilder/localCloud.js";
import { listRuntimeErrors, clearRuntimeErrors, fixPromptFor } from "../../appbuilder/runtimeErrors.js";
import { THEMES, applyTheme } from "../../appbuilder/themes.js";
import { applyTextEdit, textEditPrompt } from "../../appbuilder/textEdit.js";
import { approvePlanDraft, declinePlanDraft, editPlanDraft, resolveQuestionsCard } from "../../appbuilder/lead.js";
import { appRuntime } from "../../appbuilder/runtime.js";
import { emitProjectEvent } from "../../appbuilder/events.js";
import { insertVerifyReport } from "../../appbuilder/store.js";
import type { AppVersion } from "../../appbuilder/types.js";

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

const enginePending = (res: http.ServerResponse, what: string): boolean => {
  sendJson(res, 501, { error: "engine_pending", message: `عملية ${what} تصلك في تحديث قادم` });
  return true;
};

/** Strip the store-internal db snapshot path before a version leaves the server. */
function publicVersion(v: AppVersion & { dbSnapshot?: string | null; cover?: string | null }): AppVersion & { cover: string | null } {
  const out: AppVersion & { cover: string | null } = { ...v, cover: v.cover ?? null };
  delete (out as { dbSnapshot?: string | null }).dbSnapshot;
  return out;
}

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
  // ---- app secrets (W4b Stripe BYOK): GET is status only; PUT stores/clears through the vault and never returns values ----
  if (segments[0] === "app-secrets") {
    if (method === "GET") return sendJson(res, 200, { stripe: stripeStatus() }), true;
    if (method === "PUT") {
      const body = (await readBody(req)) as { stripe?: unknown };
      if (!body.stripe || typeof body.stripe !== "object") return sendJson(res, 400, { error: "bad_request", message: "stripe مطلوب" }), true;
      const r = setAppStripe(body.stripe as Record<string, unknown>);
      return sendJson(res, "error" in r ? 400 : 200, r), true;
    }
    return sendJson(res, 405, { error: "bad_request" }), true;
  }

  const id = segments[0]!;
  if (!ID_RE.test(id)) return sendJson(res, 400, { error: "bad_request", message: "معرّف مشروع غير صالح" }), true;
  const project = getAppProject(id);
  if (!project) return sendJson(res, 404, { error: "not_found" }), true;
  const sub = segments.slice(1);
  const rt = appRuntime();

  // ---- project level ----
  if (sub.length === 0) {
    if (method === "GET") return sendJson(res, 200, { project, devServer: rt.devServer.status(id), queue: queueState(id) }), true;
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

  // ---- runs (§4.15.2): start through the engine (or the race engine), stop unparks ----
  if (area === "runs") {
    if (sub.length === 1 && method === "POST") {
      const body = (await readBody(req)) as { prompt?: unknown; flavor?: unknown; attachments?: unknown; race?: { branches?: unknown } };
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt) return sendJson(res, 400, { error: "bad_request", message: "prompt مطلوب" }), true;
      if (prompt.length > 20_000) return sendJson(res, 400, { error: "bad_request", message: "prompt too long" }), true;
      const flavor = body.flavor === "goal" ? "goal" : body.flavor === "quick" ? "quick" : project.defaultFlavor;
      const attachments = Array.isArray(body.attachments) ? (body.attachments as string[]).filter((a) => typeof a === "string") : [];
      const raceBody = body.race && typeof body.race === "object" ? body.race : undefined;
      if (raceBody) {
        // §4.13.2: Race runs only in Build flavor.
        if (flavor === "goal") return sendJson(res, 409, { error: "queue_incompatible", message: "Race works with Build. Approve the plan first, then race the build." }), true;
        const b = Number(raceBody.branches ?? 2);
        const branches = (b === 2 || b === 3 || b === 4 ? b : 2) as 2 | 3 | 4;
        const started = rt.races.start(project, prompt, branches);
        if ("error" in started) {
          const status = started.error === "already_running" || started.error === "queue_incompatible" ? 409 : 400;
          return sendJson(res, status, { error: started.error }), true;
        }
        return sendJson(res, 200, { runId: started.runId, race: started.race }), true;
      }
      const started = rt.engine.startRun(project, { prompt, flavor, attachments });
      if ("error" in started) {
        const status = ["edit_session_open", "race_running", "queue_paused", "queue_full"].includes(started.error) ? 409 : 400;
        return sendJson(res, status, { error: started.error }), true;
      }
      return sendJson(res, 200, started), true;
    }
    if (sub[1] && sub[2] === "stop" && method === "POST") {
      const runId = sub[1]!;
      if (!getRun(runId) || getRun(runId)!.projectId !== id) return sendJson(res, 404, { error: "not_found" }), true;
      const stopped = rt.engine.stopRun(id, runId);
      return sendJson(res, 200, { ok: true, stopped }), true;
    }
    if (sub.length === 1 && method === "GET") {
      const { listRuns } = await import("../../appbuilder/store.js");
      return sendJson(res, 200, { runs: listRuns(id) }), true;
    }
    return sendJson(res, 405, { error: "bad_request" }), true;
  }

  // ---- questions (§4.15.2 POST /questions/:cardId) ----
  if (area === "questions" && sub[1] && method === "POST") {
    const body = (await readBody(req)) as { answers?: unknown; skip?: unknown };
    const cardId = sub[1]!;
    const outcome = body.skip === true
      ? { skip: true as const }
      : { answers: Array.isArray(body.answers) ? (body.answers as Array<{ questionId: string; optionIds: string[]; otherText?: string }>) : [] };
    if (!("skip" in outcome) && outcome.answers.length === 0) {
      return sendJson(res, 400, { error: "bad_request", message: "answers أو skip مطلوب" }), true;
    }
    const r = resolveQuestionsCard(project, cardId, outcome);
    if (!r.ok) {
      const status = r.error === "not_found" ? 404 : r.error === "already_resolved" ? 409 : 400;
      return sendJson(res, status, { error: r.error, ...(r.error.startsWith("answer for") || r.error.startsWith("unknown question") ? { message: r.error } : {}) }), true;
    }
    rt.engine.resolveQuestionsGate(id, cardId, r.leadMessage, "skip" in outcome ? "skipped" : "answered");
    return sendJson(res, 200, { card: r.card }), true;
  }

  // ---- plans (§4.2.2, §4.15.2) ----
  if (area === "plans") {
    if (sub.length === 1 && method === "GET") return sendJson(res, 200, { drafts: listPlanDrafts(id) }), true;
    if (sub[1] && sub[2] === "decision" && method === "POST") {
      const draftId = sub[1]!;
      const body = (await readBody(req)) as { decision?: unknown; revision?: unknown; reason?: unknown; feedback?: unknown; doc?: unknown };
      const latest = listPlanDrafts(id)[0];
      if (!latest || latest.id !== draftId) return sendJson(res, 404, { error: "not_found" }), true;
      if (body.decision === "approve") {
        if (typeof body.revision !== "number" || !Number.isInteger(body.revision)) {
          return sendJson(res, 400, { error: "bad_request", message: "revision مطلوب" }), true;
        }
        const r = approvePlanDraft(project, body.revision);
        if (!r.ok) {
          if (r.error === "stale_revision") return sendJson(res, 409, { error: "stale_revision", latest: r.latest }), true;
          const status = r.error === "not_found" ? 404 : 409;
          return sendJson(res, status, { error: r.error }), true;
        }
        // appPlanDecided is emitted by the engine when it consumes the decision.
        rt.engine.resolvePlanGate(id, { kind: "plan", decision: "approve", draft: r.draft });
        return sendJson(res, 200, { draft: r.draft }), true;
      }
      if (body.decision === "decline" || body.decision === "revise") {
        const reason = typeof body.reason === "string" ? body.reason : typeof body.feedback === "string" ? body.feedback : "";
        if (body.decision === "decline" && !reason.trim()) return sendJson(res, 400, { error: "bad_request", message: "reason مطلوب" }), true;
        const text = reason.trim() || "The user asked for a revision without giving a reason.";
        const r = declinePlanDraft(project, text);
        if (!r.ok) {
          const status = r.error === "not_found" ? 404 : 409;
          return sendJson(res, status, { error: r.error }), true;
        }
        if (r.resumeInstruction) rt.engine.resolvePlanGate(id, { kind: "plan", decision: "decline", draft: r.draft, resumeInstruction: r.resumeInstruction });
        return sendJson(res, 200, { draft: r.draft }), true;
      }
      if (body.decision === "edit") {
        const activeRun = rt.engine.activeRunFor(id);
        const r = editPlanDraft(project, activeRun?.runId ?? latest.runId, body.doc);
        if (!r.ok || !r.draft) return sendJson(res, 400, { error: r.ok ? "no_draft" : r.error, ...(r.ok ? {} : { message: r.error }) }), true;
        emitProjectEvent(id, "appPlanDecided", { projectId: id, draftId, revision: latest.revision, decision: "superseded" });
        emitProjectEvent(id, "appPlanDraft", { projectId: id, draft: r.draft });
        // The gate stays armed: the engine waits for approve/decline of the new revision.
        return sendJson(res, 200, { draft: r.draft }), true;
      }
      return sendJson(res, 400, { error: "bad_request", message: "decision يجب أن تكون approve أو decline أو revise أو edit" }), true;
    }
    return sendJson(res, 405, { error: "bad_request" }), true;
  }

  // ---- assignments / verify-reports ----
  if (area === "assignments" && sub.length === 1 && method === "GET") return sendJson(res, 200, { assignments: listAssignments(id) }), true;
  if (area === "verify-reports" && sub.length === 1 && method === "GET") {
    const limitRaw = Number(url.searchParams.get("limit") ?? "20");
    const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? limitRaw : 20;
    return sendJson(res, 200, { reports: listVerifyReports(id, limit) }), true;
  }

  // ---- versions (§4.7, §4.15.2) ----
  if (area === "versions") {
    const num = (v: string | undefined): number | null => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 ? n : null;
    };
    if (sub.length === 1 && method === "GET") {
      return sendJson(res, 200, { versions: listVersions(id).map(publicVersion) }), true;
    }
    const n = num(sub[1]);
    if (sub.length === 2 && n !== null) {
      if (method === "PATCH") {
        const body = (await readBody(req)) as { title?: unknown; summary?: unknown };
        const patch: { title?: string; summary?: string } = {};
        if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim();
        if (typeof body.summary === "string" && body.summary.trim()) patch.summary = body.summary.trim();
        const updated = updateVersionRow(id, n, patch);
        if (!updated) return sendJson(res, 404, { error: "not_found" }), true;
        emitProjectEvent(id, "appVersion", { projectId: id, phase: "updated", version: updated });
        return sendJson(res, 200, { version: publicVersion(updated) }), true;
      }
      return sendJson(res, 405, { error: "bad_request" }), true;
    }
    if (n === null && sub.length >= 2) return sendJson(res, 400, { error: "bad_request", message: "رقم إصدار غير صالح" }), true;
    const action = sub[2]!;
    if (action === "diff" && method === "GET") {
      const from = num(url.searchParams.get("from") ?? undefined) ?? Math.max(1, n! - 1);
      const file = url.searchParams.get("file") ?? undefined;
      try {
        const d = await rt.versions.diff(project, from, n!, file ?? undefined);
        return sendJson(res, 200, d), true;
      } catch {
        return sendJson(res, 404, { error: "version_not_found" }), true;
      }
    }
    if (action === "file" && method === "GET") {
      const file = url.searchParams.get("path") ?? "";
      if (!file || file.includes("..") || path.isAbsolute(file) || file.includes("\0")) return sendJson(res, 400, { error: "bad_request" }), true;
      try {
        return sendJson(res, 200, { content: await rt.versions.readFileAt(project, n!, file) }), true;
      } catch {
        return sendJson(res, 404, { error: "version_not_found" }), true;
      }
    }
    if (action === "restore" && method === "POST") {
      if (rt.engine.activeRunFor(id) || activeRaceFor(id)) return sendJson(res, 409, { error: "run_active" }), true;
      const body = (await readBody(req)) as { skipDbRestore?: unknown; message?: unknown };
      try {
        const version = await rt.versions.restore(project, n!, {
          skipDbRestore: body.skipDbRestore !== false,
          ...(typeof body.message === "string" ? { message: body.message } : {}),
          stopAppServer: async () => {
            await rt.devServer.stopApi(id);
          },
        });
        updateAppProjectRow(id, { activeVersion: version.number });
        emitProjectEvent(id, "appVersion", { projectId: id, phase: "created", version });
        return sendJson(res, 200, { version: publicVersion(version) }), true;
      } catch (err) {
        return sendJson(res, err instanceof Error && err.message === "version_not_found" ? 404 : 500, { error: err instanceof Error ? err.message : String(err) }), true;
      }
    }
    if (action === "remix" && method === "POST") {
      const body = (await readBody(req)) as { title?: unknown };
      try {
        const created = await rt.versions.remix(project, n!, {
          ...(typeof body.title === "string" && body.title.trim() ? { title: body.title.trim() } : {}),
          stopAppServer: async () => {
            await rt.devServer.stopApi(id);
          },
        });
        return sendJson(res, 200, { project: created }), true;
      } catch (err) {
        return sendJson(res, err instanceof Error && err.message === "version_not_found" ? 404 : 500, { error: err instanceof Error ? err.message : String(err) }), true;
      }
    }
    if (action === "forks" && method === "GET") return sendJson(res, 200, { projects: listForksOf(id, n!) }), true;
    if (action === "cover" && method === "PUT") {
      const body = (await readBody(req)) as { path?: unknown };
      const rel = typeof body.path === "string" ? body.path : "";
      const abs = appFile(project, rel);
      if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return sendJson(res, 404, { error: "not_found", message: "صورة الغلاف غير موجودة" }), true;
      const updated = updateVersionRow(id, n!, { cover: rel });
      if (!updated) return sendJson(res, 404, { error: "version_not_found" }), true;
      return sendJson(res, 200, { version: publicVersion(updated) }), true;
    }
    if (action === "preview" && method === "POST") {
      try {
        const devUrl = await rt.devServer.ensure(project);
        // The URL is always the local dev server; assertLocalhost-equivalent check.
        if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(devUrl)) return sendJson(res, 500, { error: "bad_preview_url" }), true;
        return sendJson(res, 200, { url: devUrl }), true;
      } catch (err) {
        return sendJson(res, 500, { error: "dev_server_failed", message: err instanceof Error ? err.message : String(err) }), true;
      }
    }
    if ((action === "publish" || action === "security-scan") && method === "POST") return enginePending(res, action === "publish" ? "النشر" : "فحص الأمان");
    return sendJson(res, 404, { error: "not_found" }), true;
  }

  // ---- edit session (§4.7.6) ----
  if (area === "edit-session" && sub.length === 1 && method === "POST") {
    const body = (await readBody(req)) as { action?: unknown; message?: unknown };
    const action = body.action;
    if (action === "start") {
      if (rt.engine.activeRunFor(id) || activeRaceFor(id)) return sendJson(res, 409, { error: "run_active" }), true;
      updateAppProjectRow(id, { status: "editing" });
      return sendJson(res, 200, { project: getAppProject(id) }), true;
    }
    if (action === "commit") {
      if (project.status !== "editing") return sendJson(res, 409, { error: "no_edit_session" }), true;
      const message = typeof body.message === "string" ? body.message.trim() : "";
      // §4.7.6 rule 3: fast verify, then snapshot; a failing verify never blocks the version.
      const report = await rt.verify.run({ project, runId: `edit_${Date.now().toString(36)}`, tier: "fast" });
      insertVerifyReport(report);
      const version = await rt.versions.snapshot(project, {
        title: message.slice(0, 60) || "Manual edit",
        summary: message.slice(0, 600) || "Manual edits saved from the Code view.",
        source: "edit",
        verifyReportId: report.id,
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, credits: 0, wallMs: 0, toolCalls: 0 },
      });
      if (version) updateAppProjectRow(id, { activeVersion: version.number, status: "idle" });
      else updateAppProjectRow(id, { status: "idle" });
      if (version) emitProjectEvent(id, "appVersion", { projectId: id, phase: "created", version });
      rt.engine.pumpProjectQueue(id);
      return sendJson(res, 200, { project: getAppProject(id), ...(version ? { version: publicVersion(version) } : {}) }), true;
    }
    if (action === "discard") {
      if (project.status !== "editing") return sendJson(res, 409, { error: "no_edit_session" }), true;
      await rt.versions.saveDiscardedAndReset(project);
      updateAppProjectRow(id, { status: "idle" });
      rt.engine.pumpProjectQueue(id);
      return sendJson(res, 200, { project: getAppProject(id) }), true;
    }
    return sendJson(res, 400, { error: "bad_request", message: "action يجب أن تكون start أو commit أو discard" }), true;
  }

  // ---- dev server (§4.8.2) ----
  if (area === "dev-server") {
    if (sub.length === 1 && method === "POST") {
      const body = (await readBody(req)) as { action?: unknown };
      if (body.action === "stop") {
        rt.devServer.stop(id);
        return sendJson(res, 200, { devServer: rt.devServer.status(id) }), true;
      }
      if (body.action === "start" || body.action === "restart") {
        rt.devServer.stop(id);
        try {
          await rt.devServer.ensure(project);
        } catch (err) {
          return sendJson(res, 500, { error: "dev_server_failed", message: err instanceof Error ? err.message : String(err) }), true;
        }
        return sendJson(res, 200, { devServer: rt.devServer.status(id) }), true;
      }
      return sendJson(res, 400, { error: "bad_request", message: "action يجب أن تكون start أو stop أو restart" }), true;
    }
    if (sub[1] === "log" && method === "GET") {
      const linesRaw = Number(url.searchParams.get("lines") ?? "200");
      const lines = Number.isInteger(linesRaw) && linesRaw >= 1 && linesRaw <= 2000 ? linesRaw : 200;
      return sendJson(res, 200, { lines: rt.devServer.logTail(id, lines) }), true;
    }
    return sendJson(res, 405, { error: "bad_request" }), true;
  }

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
    if (sub[1] === "resume" && method === "POST") {
      const q = setQueuePaused(id, false);
      rt.engine.pumpProjectQueue(id);
      return sendJson(res, 200, { queue: q }), true;
    }
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

  // ---- races (§4.13): list/estimate/choose/abort ----
  if (area === "races") {
    if (sub.length === 1 && method === "GET") return sendJson(res, 200, { races: listRaces(id) }), true;
    if (sub[1] === "estimate" && method === "GET") {
      const b = Number(url.searchParams.get("branches") ?? "2");
      const branches = b === 3 || b === 4 ? (b as 2 | 3 | 4) : 2;
      return sendJson(res, 200, { estimate: raceEstimate(id, branches) }), true;
    }
    if (sub[1] && sub[2] === "choose" && method === "POST") {
      const body = (await readBody(req)) as { branchId?: unknown };
      if (typeof body.branchId !== "string" || !body.branchId) return sendJson(res, 400, { error: "bad_request", message: "branchId مطلوب" }), true;
      const r = await rt.races.choose(project, sub[1]!, body.branchId);
      if ("error" in r) {
        const status = r.error === "not_found" || r.error === "branch_not_done" ? 404 : 409;
        return sendJson(res, status, { error: r.error }), true;
      }
      return sendJson(res, 200, { version: r.version ? publicVersion(r.version) : null }), true;
    }
    if (sub[1] && sub[2] === "abort" && method === "POST") {
      const r = await rt.races.abort(project, sub[1]!);
      if ("error" in r) {
        const status = r.error === "not_found" ? 404 : 409;
        return sendJson(res, status, { error: r.error }), true;
      }
      return sendJson(res, 200, { race: r.race }), true;
    }
    return sendJson(res, 405, { error: "bad_request" }), true;
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

  // ---- design (§4.4.3 theme, §4.8.5 text edit) ----
  if (area === "design") {
    if (sub[1] === "theme" && method === "POST") {
      const themeId = ((await readBody(req)) as { themeId?: unknown }).themeId;
      if (typeof themeId !== "string" || !THEMES.some((t2) => t2.id === themeId)) return sendJson(res, 400, { error: "bad_request" }), true;
      try {
        applyTheme(path.join(project.workspaceDir, project.appDir), themeId as (typeof THEMES)[number]["id"]);
        // §4.8.5: viewer edits open an edit session automatically.
        if (!rt.engine.activeRunFor(id) && !activeRaceFor(id) && project.status === "idle") updateAppProjectRow(id, { status: "editing" });
        return sendJson(res, 200, { ok: true }), true;
      } catch (err) {
        return sendJson(res, 400, { error: "bad_request", message: err instanceof Error ? err.message : String(err) }), true;
      }
    }
    if (sub[1] === "text-edit" && method === "POST") {
      const body = (await readBody(req)) as { src?: unknown; before?: unknown; after?: unknown };
      if (typeof body.src !== "string" || typeof body.before !== "string" || typeof body.after !== "string") {
        return sendJson(res, 400, { error: "bad_request", message: "src و before و after مطلوبة" }), true;
      }
      const r = applyTextEdit(path.join(project.workspaceDir, project.appDir), body.src, body.before, body.after);
      if (r.status === "applied" && !rt.engine.activeRunFor(id) && !activeRaceFor(id) && project.status === "idle") {
        updateAppProjectRow(id, { status: "editing" });
      }
      return sendJson(res, 200, { ...r, ...(r.status !== "applied" ? { prompt: textEditPrompt(r, body.before, body.after) } : {}) }), true;
    }
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
      // §4.9.2: writes happen only inside an edit session.
      if (project.status !== "editing") return sendJson(res, 409, { error: "no_edit_session" }), true;
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

  // ---- later-wave surfaces (§4.7.7/§4.7.8, §4.9, §4.10): not run-engine contracts ----
  if (["db", "app-users", "export"].includes(area)) {
    return enginePending(res, area === "db" ? "متصفح قاعدة البيانات" : area === "app-users" ? "مستخدمو التطبيق" : "التصدير");
  }

  return sendJson(res, 404, { error: "not_found" }), true;
}
