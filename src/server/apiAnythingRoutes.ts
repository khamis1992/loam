/** Cap H §6.13 — /api/api-anything/* panel routes. Behind the existing local-token
 *  check (hooked from http.ts right after the integrations block); every POST is
 *  same-origin; responses are no-store. Never returns cookie or session VALUES:
 *  login returns cookie names, the probe returns booleans and counts. */
import type http from "node:http";
import { DEFAULTS, type Config } from "../config.js";
import type { McpToolset } from "../tools/mcp.js";
import type { ToolRegistry } from "../tools/registry.js";
import { integrationGrants, saveIntegrationGrants } from "../tools/integrations.js";
import { appendAudit, readAudit } from "../tools/apiAnything/audit.js";
import { fitJson } from "../tools/apiAnything/budget.js";
import { probeChild, runCli } from "../tools/apiAnything/cli.js";
import { HOME_DIR, LEARN_TOOL_NAMES, MCP_PREFIX, PINNED_COMMIT, SERVER_NAME, SITE_RE, UPSTREAM_VERSION } from "../tools/apiAnything/constants.js";
import { aclPrincipals } from "../tools/apiAnything/home.js";
import { rewriteNextDeep } from "../tools/apiAnything/nextHints.js";
import { opIndex } from "../tools/apiAnything/opIndex.js";
import { apiAnythingReadiness } from "../tools/apiAnything/server.js";
import { applyUserSettings, loadUserSettings, saveUserSettings } from "../tools/apiAnything/settings.js";
import type { ApiAnythingStatus, ApiAnythingUserSettings, ChildProbe } from "../tools/apiAnything/types.js";

export interface ApiAnythingRouteDeps {
  cfg: Config;
  mcp: McpToolset | null;
  registry: ToolRegistry | undefined;
  sendJson(res: http.ServerResponse, status: number, body: unknown): void;
  readBody(req: http.IncomingMessage, maxBytes?: number): Promise<unknown>;
  /** Flags the running process started with; restart-only settings are compared against these. */
  startedWith: { enabled: boolean; allowWrites: boolean; allowWriteLearning: boolean };
}

let panelLoginOpen = false;

function sameOrigin(req: http.IncomingMessage): boolean {
  return !((req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || req.headers["sec-fetch-site"] === "cross-site");
}

function restartRequired(deps: ApiAnythingRouteDeps): boolean {
  const s = loadUserSettings();
  const now = deps.startedWith;
  return (
    (s.enabled !== undefined && s.enabled !== now.enabled) ||
    (s.allowWrites !== undefined && s.allowWrites !== now.allowWrites) ||
    (s.allowWriteLearning !== undefined && s.allowWriteLearning !== now.allowWriteLearning)
  );
}

/** Returns true when the request was handled. */
export async function handleApiAnythingRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: ApiAnythingRouteDeps): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith("/api/api-anything/")) return false;
  res.setHeader("cache-control", "no-store");
  const { cfg, mcp, sendJson } = deps;
  // Optional on Config for test fixtures; the server always runs loadConfig first.
  const a = cfg.apiAnything ?? DEFAULTS.apiAnything!;
  const readiness = apiAnythingReadiness(cfg);
  const running = !!mcp && mcp.servers.includes(SERVER_NAME);
  const siteOf = (v: unknown): string | undefined => (typeof v === "string" && SITE_RE.test(v) ? v : undefined);
  const allowed = (site: string): boolean => a.sites === "all" || a.sites.includes(site);

  if (req.method === "GET") {
    if (p === "/api/api-anything/status") {
      const server = running ? (await mcp!.status()).find((s) => s.name === SERVER_NAME) : undefined;
      const probe = readiness.ready ? await probeChild(a) : undefined;
      const body: ApiAnythingStatus = {
        enabled: a.enabled,
        readiness,
        commit: PINNED_COMMIT,
        version: UPSTREAM_VERSION,
        home: HOME_DIR,
        acl: aclPrincipals(),
        server: server ? { connected: server.connected, toolCount: server.toolCount } : { connected: false, toolCount: 0 },
        node: probe && !("error" in probe) ? probe.node : undefined,
        browser: probe && !("error" in probe) ? probe.browser : undefined,
        probeError: probe && "error" in probe ? probe.error.slice(0, 300) : undefined,
        settings: {
          allowWrites: a.allowWrites,
          allowWriteLearning: a.allowWriteLearning,
          learnDomains: a.learnDomains,
          peopleOpsTasks: a.peopleOpsTasks,
          sites: a.sites,
        },
        restartRequired: restartRequired(deps),
      };
      sendJson(res, 200, body);
      return true;
    }
    if (p === "/api/api-anything/sites") {
      opIndex.refresh();
      const probe = readiness.ready ? await probeChild(a) : undefined;
      const sessions = new Map((probe && !("error" in probe) ? (probe as ChildProbe).sites : []).map((s) => [s.name, s]));
      sendJson(res, 200, {
        sites: opIndex.sites().map((s) => {
          const live = sessions.get(s.site);
          return {
            ...s,
            enabled: allowed(s.site),
            loggedIn: live && "loggedIn" in live ? live.loggedIn : undefined,
            cookieCount: live && "cookieCount" in live ? live.cookieCount : undefined,
            sessionSource: live && "source" in live ? live.source : undefined,
            updatedAt: live && "updatedAt" in live ? live.updatedAt : undefined,
          };
        }),
      });
      return true;
    }
    if (p === "/api/api-anything/ops") {
      const site = siteOf(url.searchParams.get("site"));
      if (!site) return sendJson(res, 400, { error: "site is required" }), true;
      sendJson(res, 200, { site, operations: opIndex.operations(site) });
      return true;
    }
    if (p === "/api/api-anything/audit") {
      const n = Number(url.searchParams.get("limit") ?? "50");
      sendJson(res, 200, { lines: readAudit(Number.isInteger(n) && n >= 1 && n <= 200 ? n : 50) });
      return true;
    }
    sendJson(res, 404, { error: "Not found" });
    return true;
  }

  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" }), true;
  if (!sameOrigin(req)) return sendJson(res, 403, { error: "Same-origin requests required" }), true;
  const body = (await deps.readBody(req, 64_000)) as Record<string, unknown>;

  if (p === "/api/api-anything/settings") {
    const saved = saveUserSettings(body as ApiAnythingUserSettings);
    applyUserSettings(a, saved, false);
    sendJson(res, 200, { settings: saved, restartRequired: restartRequired(deps) });
    return true;
  }

  if (!running) return sendJson(res, 503, { error: "واجهات المواقع غير مفعلة أو لم تبدأ بعد" }), true;

  if (p === "/api/api-anything/grant") {
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const names = deps.registry ? deps.registry.names().filter((n) => n.startsWith(MCP_PREFIX) || (LEARN_TOOL_NAMES as readonly string[]).includes(n)) : [];
    try {
      saveIntegrationGrants(taskId, [...new Set([...integrationGrants(taskId), ...names])], deps.registry!);
      sendJson(res, 200, { enabled: integrationGrants(taskId) });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  const site = siteOf(body.site);
  if (!site || !allowed(site)) return sendJson(res, 400, { error: "site is not enabled" }), true;

  if (p === "/api/api-anything/login") {
    if (panelLoginOpen) return sendJson(res, 409, { error: "نافذة تسجيل الدخول مفتوحة بالفعل" }), true;
    panelLoginOpen = true;
    try {
      const r = await mcp!.callTool(SERVER_NAME, "login", { site, mode: "window" }, a.timeouts.loginMs);
      let value: unknown;
      try {
        value = JSON.parse(r.content);
      } catch {
        value = { ok: false, site, error: r.content.slice(0, 300) };
      }
      const v = value as { ok?: boolean; cookies?: unknown; loggedIn?: unknown; error?: unknown; next?: unknown };
      appendAudit({ taskId: null, tool: "login", site, argNames: [], argsSha256: undefined, decision: "sent", class: v.ok ? "ok" : "error" });
      sendJson(res, 200, rewriteNextDeep({ ok: v.ok === true, site, cookies: Array.isArray(v.cookies) ? v.cookies.filter((c) => typeof c === "string") : undefined, loggedIn: v.loggedIn === true, error: typeof v.error === "string" ? v.error : undefined, next: typeof v.next === "string" ? v.next : undefined }));
    } finally {
      panelLoginOpen = false;
    }
    return true;
  }

  if (p === "/api/api-anything/logout" || p === "/api/api-anything/verify") {
    const cmd = p.endsWith("logout") ? "logout" : "verify";
    const run = await runCli([cmd, site], a, { timeoutMs: cmd === "verify" ? a.timeouts.learnMs : a.timeouts.listMs });
    appendAudit({ taskId: null, tool: `panel_${cmd}`, site, argNames: [], argsSha256: undefined, decision: "sent", class: run.code === 0 ? "ok" : "error", ms: run.ms });
    opIndex.refresh();
    const value = run.json ?? { ok: false, error: run.stderr, next: run.next };
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.writeHead(run.code === 0 ? 200 : 502);
    res.end(fitJson(rewriteNextDeep(value), 200_000));
    return true;
  }

  sendJson(res, 404, { error: "Not found" });
  return true;
}
