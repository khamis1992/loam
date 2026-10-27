import type http from "node:http";
import type { CodeGraphService } from "../../codegraph/service.js";
import { checkRuntime, installRuntime, uninstallRuntime } from "../../codegraph/runtime.js";
import { codeGraphHome } from "../../codegraph/paths.js";
import { resolveCodeGraphConfig, type CodeGraphConfig } from "../../codegraph/config.js";

/**
 * /api/codegraph/* routes. Mounted from src/server/http.ts with ONE line placed
 * next to the existing "/api/mcp/status" branch:
 *
 *   if (p.startsWith("/api/codegraph/") && await handleCodeGraphRoute(req, res, p, url, codeGraphRouteDeps)) return;
 *
 * Every mutating route is POST/DELETE and enforces the same same-origin rule
 * Loam already uses for its own mutating routes (OBSERVED loam
 * src/server/http.ts:519, :530, :609-610), so a web page in the user's browser
 * cannot start an install or opt a project in via http://127.0.0.1:3939.
 */
export function isCrossOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  return (!!origin && origin !== `http://${req.headers.host}`) || req.headers["sec-fetch-site"] === "cross-site";
}

export interface CodeGraphRouteDeps {
  svc: () => CodeGraphService | null;
  cfg: () => Partial<CodeGraphConfig> | undefined;
  sendJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readBody: (req: http.IncomingMessage, maxBytes?: number) => Promise<unknown>;
  /** requireTaskWorkspace(taskId, cfg.workspace) in Loam: throws on unknown task ids. */
  resolveWorkspace: (taskId: unknown) => string;
  /** rootAsset("resources", "codegraph", ...) in Loam. */
  uvExe: string;
  uvSha256: string;
  lockFile: string;
  lockSha256: string;
}

interface InstallState { running: boolean; step: string | null; startedAt: number | null; result: unknown }
const install: InstallState = { running: false, step: null, startedAt: null, result: null };

function bodyField(body: unknown, key: string): unknown {
  return body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
}

export async function handleCodeGraphRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  url: URL,
  deps: CodeGraphRouteDeps,
): Promise<boolean> {
  const method = req.method ?? "GET";
  if (method !== "GET" && isCrossOrigin(req)) { deps.sendJson(res, 403, { error: "Same-origin requests required" }); return true; }
  const cfg = resolveCodeGraphConfig(deps.cfg());
  const home = codeGraphHome(cfg);

  if (method === "GET" && p === "/api/codegraph/status") {
    const runtime = await checkRuntime(home);
    const svc = deps.svc();
    const taskId = url.searchParams.get("taskId");
    // GET is side-effect free; the "workspace became active" signal is POST /project/open.
    const project = svc && taskId ? await svc.status(deps.resolveWorkspace(taskId)) : null;
    deps.sendJson(res, 200, {
      enabled: cfg.enabled,
      autoIndex: cfg.autoIndex,
      runtime: { state: runtime.state, version: runtime.version ?? null, detail: runtime.detail ?? null },
      install: { running: install.running, step: install.step, startedAt: install.startedAt, result: install.result },
      project,
      // the Services view treats `ok` as the green/red dot
      ok: cfg.enabled ? runtime.state === "ready" : true,
    });
    return true;
  }

  if (method === "POST" && p === "/api/codegraph/runtime/install") {
    if (install.running) { deps.sendJson(res, 409, { error: "install already running", step: install.step }); return true; }
    install.running = true; install.step = "starting"; install.startedAt = Date.now(); install.result = null;
    void installRuntime({
      home, uvExe: deps.uvExe, uvSha256: deps.uvSha256, lockFile: deps.lockFile, lockSha256: deps.lockSha256,
      onStep: (label) => { install.step = label; },
    }).then((r) => { install.result = r; }, (e: unknown) => { install.result = { ok: false, detail: e instanceof Error ? e.message : String(e) }; })
      .finally(() => { install.running = false; install.step = null; });
    deps.sendJson(res, 202, { started: true });
    return true;
  }

  if (method === "DELETE" && p === "/api/codegraph/runtime") {
    if (install.running) { deps.sendJson(res, 409, { error: "install running" }); return true; }
    await deps.svc()?.dispose();
    uninstallRuntime(home, url.searchParams.get("purgeGraphs") === "1");
    deps.sendJson(res, 200, { removed: true });
    return true;
  }

  const svc = deps.svc();
  if (!svc && p.startsWith("/api/codegraph/project")) { deps.sendJson(res, 409, { error: "code map is disabled in settings" }); return true; }

  if (svc && method === "POST" && (p === "/api/codegraph/project/open" || p === "/api/codegraph/project/optin" || p === "/api/codegraph/project/optout" || p === "/api/codegraph/project/index")) {
    const body = await deps.readBody(req, 10_000);
    let ws: string;
    try { ws = deps.resolveWorkspace(bodyField(body, "taskId")); } catch (e) { deps.sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) }); return true; }
    if (p.endsWith("/open")) {
      // UI calls this when a task's workspace is shown; returns none | ask-consent | index.
      const d = await svc.onWorkspaceOpen(ws);
      deps.sendJson(res, 200, { decision: d.action, project: d.status });
    } else if (p.endsWith("/optin")) {
      svc.indexer.optIn(ws);
      const job = svc.indexer.requestIndex(ws, "consent-first-open");
      deps.sendJson(res, 200, { optedIn: true, job });
    } else if (p.endsWith("/optout")) {
      // body.decline === true is «أبداً» (stop asking); otherwise «لاحقاً» / turn off.
      svc.indexer.optOut(ws, { decline: bodyField(body, "decline") === true });
      deps.sendJson(res, 200, { optedIn: false, declined: bodyField(body, "decline") === true });
    } else {
      try {
        const job = svc.indexer.requestIndex(ws, "user", { full: bodyField(body, "full") === true });
        deps.sendJson(res, 202, { job });
      } catch (e) { deps.sendJson(res, 409, { error: e instanceof Error ? e.message : String(e) }); }
    }
    return true;
  }

  if (svc && method === "DELETE" && p === "/api/codegraph/project") {
    let ws: string;
    try { ws = deps.resolveWorkspace(url.searchParams.get("taskId")); } catch (e) { deps.sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) }); return true; }
    svc.indexer.purge(ws);
    deps.sendJson(res, 200, { purged: true });
    return true;
  }

  return false;
}
