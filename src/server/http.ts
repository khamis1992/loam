import http from "node:http";
import { createHash } from "node:crypto";
import { requireTaskWorkspace, taskPath } from "./taskWorkspace.js";
import { getLoamMode } from "../modes/catalog.js";
import { readStudio, saveStudio, StudioError } from "../studio/store.js";
import { exportStudio } from "../studio/export.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import nodeChildProcess from "node:child_process";
import { ROOT, UI_DIR, DATA_DIR, type Config } from "../config.js";
import type { OllamaClient } from "../ollama.js";
import type { AgentEvent, Emit } from "../agent/events.js";
import { log, redact } from "../log.js";
import { isInside, resolveRead, resolveWrite } from "../policy/paths.js";
import type { MemoryStore } from "../memory/store.js";
import { getPending, listPending, removePending, type PendingItem } from "./pending.js";
import { applySkill, buildSkillFile, listSkillRecords, readSkillFile } from "../tools/skills.js";
import { extractOfficeText, OFFICE_EXT, prepareParser as buildPdfParser } from "../tools/attachments.js";
import { loadHooksConfig, saveWorkspaceHooks, type HooksConfig } from "../policy/hooks.js";
import { outlineWorkspacePath, queryWorkspaceSymbols } from "../tools/symbols.js";
import { buildPentestMarkdownReport, PENTEST_CHECKS, runPentestCheck, scanWorkspaceRoutesAndRisks } from "../tools/pentest.js";
import { loadActiveMirofishSession, runConversationalMirofish } from "../tools/mirofish.js";
import { detectFrontierMode, getFrontierBridgeStatus, getFrontierModesUi, switchFrontierMode } from "../tools/frontierBridge.js";
import { installFromCatalog, searchCatalog } from "../tools/skillsRegistry.js";
import type { ScreenLive } from "../screen/live.js";
import {
  killSession,
  listSessions,
  ptyAvailable,
  ptyStatus,
  resizeSession,
  sessionSnapshot,
  startSession,
  subscribe,
  writeSession,
} from "../tools/pty.js";
import {
  addSchedule,
  createProject,
  createTask,
  setTaskMode,
  setTaskStatus,
  deleteProjectR,
  deleteSchedule,
  getProject,
  getTask,
  listProjects,
  listSchedules,
  listTasks,
  updateProject,
} from "./db.js";
import { getSettings, updateSettings } from "./settings.js";
import { cancelRunSignal } from "./runControl.js";
import { createAgent, deleteAgent, getAgent, listAgents, updateAgent } from "./agents.js";
import { subscribeTask } from "./streams.js";
import { appendLearning, readLearning } from "./learning.js";
import type { ToolRegistry } from "../tools/registry.js";
import { installDraft, listSuites, loadSuite } from "../eval/suites.js";
import { activeSummary, getRun, lastRunForSuite, listRuns } from "../eval/store.js";
import { evalBusy, runSuiteBackground } from "../eval/service.js";
import type { EvalDeps } from "../eval/runner.js";
import { telemetrySummary } from "../telemetry/store.js";
import { generateSelfPlayDraft } from "../learning/selfplay.js";
import { exportDatasets } from "../eval/export.js";
import type { PreviewService } from "../preview/serve.js";
import { getBrowserState } from "../tools/browser.js";
import { getSavedRun } from "./db.js";
import { requiresReplayConfirmation } from "./recovery.js";
import { executionQueue } from "./executionQueue.js";
import type { McpToolset } from "../tools/mcp.js";

export interface RunTaskOptions {
  prompt: string;
  emit: Emit;
  taskId?: string;
  title?: string;
  model?: string;
  projectId?: string | null;
  mode?: string;
  effort?: string;
  agentId?: string;
  resume?: boolean;
  retryInterruptedStep?: boolean;
  scheduleId?: string;
}

export interface ServerDeps {
  cfg: Config;
  ollama: OllamaClient;
  memory?: MemoryStore;
  screenLive?: ScreenLive;
  preview?: PreviewService;
  registry?: ToolRegistry;
  mcp?: McpToolset | null;
  runTask: (opts: RunTaskOptions) => Promise<{ taskId: string; text: string }>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function parseWorktrees(porcelainOut: string): Array<{ path: string; head: string; branch: string; bare: boolean; detached: boolean }> {
  const out: Array<{ path: string; head: string; branch: string; bare: boolean; detached: boolean }> = [];
  let cur: { path: string; head: string; branch: string; bare: boolean; detached: boolean } | null = null;
  for (const line of porcelainOut.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: line.slice(9).trim(), head: "", branch: "", bare: false, detached: false };
    } else if (cur && line.startsWith("HEAD ")) {
      cur.head = line.slice(5).trim();
    } else if (cur && line.startsWith("branch ")) {
      const ref = line.slice(7).trim();
      cur.branch = ref.replace(/^refs\/heads\//, "");
    } else if (cur && line === "bare") {
      cur.bare = true;
    } else if (cur && line === "detached") {
      cur.detached = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function readBody(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on("error", reject);
  });
}

/** Read a raw (binary) request body, e.g. a dropped file from the home drop-zone. */
async function readRawBody(req: http.IncomingMessage, maxBytes = 50_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function serveStatic(res: http.ServerResponse, urlPath: string): void {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.resolve(UI_DIR, rel);
  if (!file.startsWith(path.resolve(UI_DIR))) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

const TEXT_EXTRACT_EXT = new Set([
  ".txt", ".md", ".markdown", ".csv", ".json", ".jsonl", ".tsv", ".log", ".yml", ".yaml", ".html", ".xml",
  ".js", ".ts", ".py", ".css", ".sql", ".pdf", ".docx", ".xlsx", ".pptx",
]);
const IMAGE_EXTRACT_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const ATTACH_INLINE_CHARS = 24_000;

/** Compose the attachment block for a task prompt: inline extracted text for
 *  documents (PDF/DOCX/XLSX/PPTX included), and reading directives for images/other types. */
async function buildAttachmentsBlock(raw: unknown, workspace: string): Promise<string> {
  const list = Array.isArray(raw) ? raw : [];
  const parts: string[] = [];
  for (const item of list.slice(0, 8)) {
    if (typeof item !== "object" || item === null) continue;
    const rel = String((item as Record<string, unknown>).path ?? "").trim();
    const name = String((item as Record<string, unknown>).name ?? rel.split("/").pop() ?? "attachment");
    if (!rel) continue;
    let abs: string | null = null;
    try {
      const candidate = taskPath(workspace, rel);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) abs = candidate;
    } catch {
      abs = null;
    }
    if (!abs) {
      parts.push(`• مرفق مفقود: ${rel}`);
      continue;
    }
    const ext = path.extname(abs).toLowerCase();
    if (TEXT_EXTRACT_EXT.has(ext) && fs.statSync(abs).size < 20 * 1024 * 1024) {
      let text = "";
      try {
        if (ext === ".pdf") {
          const mod = await buildPdfParser();
          const parser = new mod.PDFParse({ data: new Uint8Array(fs.readFileSync(abs)) });
          try {
            const pdfResult = await parser.getText();
            const pdfText = String(pdfResult?.text ?? "");
            parts.push(
              `• [مستند "${name}"] عدد الصفحات: ${pdfResult?.total ?? "?"} — النص:\n<attachment id="${rel}">\n${pdfText.slice(0, ATTACH_INLINE_CHARS)}${pdfText.length > ATTACH_INLINE_CHARS ? `\n…(مقتطع؛ للاكتمال استخدم file_extract_text على ${rel})` : ""}\n</attachment>`,
            );
          } finally {
            try { await parser.destroy(); } catch { /* ignore */ }
          }
        } else if (OFFICE_EXT.has(ext)) {
          text = extractOfficeText(abs);
          parts.push(
            `• [مستند "${name}" (${ext})] النص:\n<attachment id="${rel}">\n${text.slice(0, ATTACH_INLINE_CHARS)}${text.length > ATTACH_INLINE_CHARS ? `\n…(مقتطع؛ للاكتمال استخدم file_extract_text على ${rel})` : ""}\n</attachment>`,
          );
        } else {
          text = fs.readFileSync(abs, "utf8");
          parts.push(`• [ملف "${name}"] ${text.slice(0, ATTACH_INLINE_CHARS)}${text.length > ATTACH_INLINE_CHARS ? `\n…(مقتطع؛ للاكتمال استخدم file_extract_text على ${rel})` : ""}`);
        }
      } catch (err) {
        parts.push(`• تعذّر استخراج ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (IMAGE_EXTRACT_EXT.has(ext)) {
      parts.push(`• [صورة "${name}"] استخدم أداة file_view_image بمسار ${rel} لرؤيتها.`);
    } else {
      parts.push(`• [ملف "${name}"] (${ext}) — داخل المساحة: استخدم file_read أو الأدوات المناسبة.`);
    }
  }
  if (parts.length === 0) return "";
  return `【المرفقات — تحليلها جزء من المهمة， وتابع عملك عليها】\n${parts.join("\n")}`;
}

async function applyPendingItem(item: PendingItem, memory?: MemoryStore): Promise<string> {
  if (item.kind === "memory_store") {
    if (!memory) throw new Error("memory disabled in config");
    const text = String(item.payload["text"] ?? "").trim();
    if (!text) throw new Error("staged memory entry has no text");
    const kind = typeof item.payload["kind"] === "string" ? item.payload["kind"] : "note";
    const tags = Array.isArray(item.payload["tags"]) ? (item.payload["tags"] as unknown[]).map((t) => String(t)) : [];
    const entry = await memory.add(text, { kind, tags });
    return `memory_store ${entry.id}`;
  }
  if (item.kind === "skill_install") {
    const res = await installFromCatalog({
      id: String(item.payload["id"] ?? ""),
      force: item.payload["force"] === true,
    });
    return `skill_install ${res.id}`;
  }
  const res = applySkill(item.kind, item.payload);
  if (!res.ok) throw new Error(res.content);
  return res.content;
}

export function startServer(deps: ServerDeps): Promise<http.Server> {
  const { cfg, ollama, runTask } = deps;
  const memory = deps.memory;
  const live = deps.screenLive;
  const preview = deps.preview;
  const registry = deps.registry;
  const mcp = deps.mcp ?? null;
  void createTask;

  const memorySkillsCall = async (
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
    if (!mcp || !mcp.servers.includes("memory-skills")) {
      return { ok: false, error: "memory-skills MCP server is not running" };
    }
    const res = await mcp.callTool("memory-skills", tool, args, 30_000);
    return res.ok ? { ok: true, text: res.content } : { ok: false, error: res.content };
  };

  const evalDeps = (): EvalDeps => {
    if (!registry) throw new Error("التقييم غير متاح في هذه الجلسة");
    return { cfg, ollama, registry, critique: cfg.evaluation.critique };
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const p = url.pathname;

    void (async (): Promise<void> => {
      try {
        if (req.method === "GET" && (p === "/" || MIME[path.extname(p).toLowerCase()] !== undefined)) {
          serveStatic(res, p);
          return;
        }

        if (req.method === "GET" && p === "/api/models") {
          const models = await ollama.listModels();
          sendJson(res, 200, { models });
          return;
        }

        if (req.method === "GET" && p === "/api/system/info") {
          const cpus = os.cpus();
          sendJson(res, 200, {
            os: os.type(),
            osRelease: os.release(),
            arch: os.arch(),
            cpuModel: cpus[cpus.length > 0 ? 0 : 0]?.model ?? "",
            cpuCount: cpus.length,
            memTotalGB: Math.round(os.totalmem() / 1073741824),
            memFreeGB: Math.round(os.freemem() / 1073741824),
            uptimeH: Math.round(os.uptime() / 3600),
            hostname: os.hostname(),
          });
          return;
        }

        if (req.method === "GET" && p === "/api/config") {
          sendJson(res, 200, {
            model: cfg.model,
            fallbackModel: cfg.fallbackModel,
            workspace: cfg.workspace,
            networkEnabled: cfg.policy.networkEnabled,
            maxCommandSeconds: cfg.policy.maxCommandSeconds,
            browserChannel: cfg.browser.channel,
            computerUseEnabled: cfg.computerUse.enabled,
            mcpServers: Object.keys(cfg.mcpServers),
          });
          return;
        }

        if (req.method === "GET" && p === "/api/identity") {
          const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string };
          const dataPath = path.resolve(DATA_DIR);
          const profileId = createHash("sha256").update(process.platform === "win32" ? dataPath.toLowerCase() : dataPath).digest("hex");
          sendJson(res, 200, { application: "Loam", version: pkg.version, apiVersion: 1, profileId });
          return;
        }

        if (req.method === "GET" && p === "/api/mcp/status") {
          sendJson(res, 200, { servers: mcp?.status ? await mcp.status() : Object.keys(cfg.mcpServers).map(name => ({ name, connected: false, toolCount: 0 })) });
          return;
        }

        // ---- working folder (repo/project) picker ----
        if (req.method === "GET" && p === "/api/hooks") {
          sendJson(res, 200, { workspace: requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace), hooks: loadHooksConfig(requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace)) });
          return;
        }

        if (req.method === "POST" && p === "/api/hooks") {
          const body = (await readBody(req)) as HooksConfig;
          const file = saveWorkspaceHooks(requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace), body);
          sendJson(res, 200, { ok: true, file, hooks: loadHooksConfig(requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace)) });
          return;
        }

        if (req.method === "GET" && p === "/api/symbols") {
          const outlinePath = url.searchParams.get("path");
          if (outlinePath !== null && outlinePath.trim().length > 0) {
            try {
              sendJson(res, 200, { outlines: outlineWorkspacePath(requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace), taskPath(requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace), outlinePath)) });
            } catch (err) {
              sendJson(res, 404, { error: err instanceof Error ? err.message : String(err) });
            }
            return;
          }
          const q = url.searchParams.get("q") ?? "";
          const kind = url.searchParams.get("kind") ?? "";
          const limit = Number(url.searchParams.get("limit") ?? 80) || 80;
          const refresh = url.searchParams.get("refresh") === "1";
          sendJson(res, 200, queryWorkspaceSymbols(requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace), { query: q, kind, limit, refresh }));
          return;
        }

        if (req.method === "GET" && p === "/api/pentest/checks") {
          sendJson(res, 200, { checks: PENTEST_CHECKS, workspace: requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace) });
          return;
        }

        if (req.method === "POST" && p === "/api/pentest/scan") {
          const body = (await readBody(req)) as { target?: string; check?: string; writeReport?: boolean };
          const target = typeof body.target === "string" ? body.target.trim() : "";
          const check = typeof body.check === "string" && body.check.trim() ? body.check.trim() : "all";
          const findings = target ? await runPentestCheck(target, check) : [];
          const scan = scanWorkspaceRoutesAndRisks(requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace));
          const report = buildPentestMarkdownReport({
            target: target || "فحص مصدري لمساحة العمل",
            workspace: requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace),
            findings,
            scan,
          });
          let reportFile = "";
          if (body.writeReport !== false) {
            try {
              reportFile = taskPath(requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace), "pentest-report.md");
              fs.writeFileSync(reportFile, report, "utf8");
            } catch {
              reportFile = "";
            }
          }
          sendJson(res, 200, { ok: true, target, workspace: requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace), findings, scan, report, reportFile });
          return;
        }

        if (req.method === "GET" && p === "/api/workspace") {
          const st = getSettings();
          sendJson(res, 200, { root: cfg.workspace, recent: st.recentWorkspaces ?? [] });
          return;
        }

        if (req.method === "POST" && p === "/api/workspace") {
          const body = (await readBody(req)) as { path?: unknown };
          const raw = typeof body.path === "string" ? body.path.trim().replace(/^"|"$/g, "") : "";
          if (!raw) return sendJson(res, 400, { error: "المسار مطلوب" });
          const abs = path.resolve(raw);
          try {
            if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
              return sendJson(res, 400, { error: `ليس مجلداً موجوداً: ${abs}` });
            }
            fs.accessSync(abs, fs.constants.R_OK | fs.constants.W_OK);
          } catch (err) {
            return sendJson(res, 403, { error: `لا يمكن الوصول للمجلد: ${abs}` });
          }
          cfg.workspace = abs;
          const st = getSettings();
          const recent = [abs, ...(st.recentWorkspaces ?? []).filter((x) => x !== abs)].slice(0, 8);
          updateSettings({ workspace: abs, recentWorkspaces: recent });
          log.info(`workspace switched to ${abs}`);
          sendJson(res, 200, { ok: true, root: abs, recent });
          return;
        }

        if (p === "/api/worktree" || p.startsWith("/api/worktree/")) {
          return sendJson(res, 410, { error: "مساحات Loam معزولة وثابتة لكل مهمة؛ إدارة أشجار العمل المشتركة غير متاحة." });
        }

        if (p === "/api/launch") return sendJson(res, 410, { error: "استخدم مساحات Loam المدمجة بدلاً من مشغّل التطبيقات الخارجي." });

        if (req.method === "GET" && p.startsWith("/vendor/")) {
          const vendorMap: Record<string, string> = {
            "/vendor/xterm.js": path.join(ROOT, "node_modules", "@xterm", "xterm", "lib", "xterm.js"),
            "/vendor/xterm.css": path.join(ROOT, "node_modules", "@xterm", "xterm", "css", "xterm.css"),
            "/vendor/addon-fit.js": path.join(ROOT, "node_modules", "@xterm", "addon-fit", "lib", "addon-fit.js"),
          };
          const file = vendorMap[p];
          if (!file || !fs.existsSync(file)) {
            res.writeHead(404, { "content-type": "text/plain" }).end("not found");
            return;
          }
          res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
          fs.createReadStream(file).pipe(res);
          return;
        }

        if (req.method === "GET" && p === "/api/pty/status") {
          sendJson(res, 200, { available: ptyAvailable(), status: ptyStatus() });
          return;
        }

        if (req.method === "GET" && p === "/api/pty") {
          const root = requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace);
          sendJson(res, 200, { sessions: listSessions().filter(s => isInside(root, s.cwd)), available: ptyAvailable() });
          return;
        }

        if (req.method === "POST" && p === "/api/pty") {
          if (!ptyAvailable()) return sendJson(res, 503, { error: ptyStatus() });
          const body = (await readBody(req)) as { taskId?: unknown; shell?: unknown; cwd?: unknown; cols?: unknown; rows?: unknown };
          try {
            const shell = body.shell === "cmd" ? "cmd" : "powershell";
            const cwd = taskPath(requireTaskWorkspace(body.taskId, cfg.workspace), typeof body.cwd === "string" && body.cwd ? body.cwd : ".");
            const session = startSession(shell, cwd, Number(body.cols) || 120, Number(body.rows) || 30);
            sendJson(res, 200, { id: session.id, shell, cwd });
          } catch (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        if (p.startsWith("/api/pty/")) {
          const rest = p.slice("/api/pty/".length);
          const slash = rest.indexOf("/");
          const id = decodeURIComponent(slash >= 0 ? rest.slice(0, slash) : rest);
          const sub = slash >= 0 ? rest.slice(slash + 1) : "";
          const root = requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace);
          if (!listSessions().some(s => s.id === id && isInside(root, s.cwd))) return sendJson(res, 404, { error: "session not found in task" });

          if (req.method === "GET" && sub === "stream") {
            const snap = sessionSnapshot(id);
            res.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache, no-transform",
              connection: "keep-alive",
            });
            if (!snap) {
              res.write(`data: ${JSON.stringify({ type: "error", message: `no such pty session: ${id}` })}\n\n`);
              res.end();
              return;
            }
            const recent = snap.buffer.length > 20_000 ? snap.buffer.slice(-20_000) : snap.buffer;
            if (recent) res.write(`data: ${JSON.stringify({ type: "data", data: recent })}\n\n`);
            const unsub = subscribe(id, (chunk) => {
              res.write(`data: ${JSON.stringify({ type: "data", data: chunk })}\n\n`);
            });
            if (!unsub) {
              res.write(`data: ${JSON.stringify({ type: "exit" })}\n\n`);
              res.end();
              return;
            }
            const keepalive = setInterval(() => res.write(": ping\n\n"), 15_000);
            req.on("close", () => {
              clearInterval(keepalive);
              unsub();
            });
            return;
          }

          if (req.method === "POST" && sub === "input") {
            const body = (await readBody(req)) as { data?: unknown };
            try {
              writeSession(id, typeof body.data === "string" ? body.data : "");
              sendJson(res, 200, { ok: true });
            } catch (err) {
              sendJson(res, 404, { error: err instanceof Error ? err.message : String(err) });
            }
            return;
          }

          if (req.method === "POST" && sub === "resize") {
            const body = (await readBody(req)) as { cols?: unknown; rows?: unknown };
            resizeSession(id, Number(body.cols) || 120, Number(body.rows) || 30);
            sendJson(res, 200, { ok: true });
            return;
          }

          if (req.method === "GET" && sub === "output") {
            const snap = sessionSnapshot(id);
            if (!snap) return sendJson(res, 404, { error: `no such pty session: ${id}` });
            const max = Math.max(1000, Number(url.searchParams.get("maxChars") ?? 6000));
            const data = snap.buffer.length > max ? snap.buffer.slice(-max) : snap.buffer;
            sendJson(res, 200, { data });
            return;
          }

          if (req.method === "DELETE" && sub === "") {
            sendJson(res, 200, { killed: killSession(id) });
            return;
          }
        }

        if (req.method === "GET" && p === "/api/memory/status") {
          sendJson(res, 200, {
            enabled: Boolean(memory),
            count: memory?.count ?? 0,
            model: cfg.memory.model,
            file: cfg.memory.file,
            autoStore: cfg.memory.autoStore,
          });
          return;
        }

        if (req.method === "GET" && p === "/api/memory") {
          if (!memory) return sendJson(res, 200, { entries: [], hits: [] });
          const query = url.searchParams.get("query") ?? "";
          const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 30), 1), 200);
          if (query.trim()) {
            const hits = await memory.search(query, Math.min(limit, 20), -1);
            sendJson(res, 200, { hits: hits.map((h) => ({ score: h.score, entry: h.entry })) });
            return;
          }
          sendJson(res, 200, { entries: memory.list(limit) });
          return;
        }

        if (req.method === "POST" && p === "/api/memory") {
          if (!memory) return sendJson(res, 503, { error: "memory disabled in config" });
          const body = (await readBody(req)) as { text?: unknown; kind?: unknown; tags?: unknown };
          const text = typeof body.text === "string" ? body.text.trim() : "";
          if (!text) return sendJson(res, 400, { error: "text required" });
          const tags = Array.isArray(body.tags) ? (body.tags as unknown[]).map((t) => String(t)) : [];
          try {
            const entry = await memory.add(text, { kind: typeof body.kind === "string" ? body.kind : "note", tags });
            sendJson(res, 200, { entry });
          } catch (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        if (req.method === "DELETE" && p.startsWith("/api/memory/")) {
          if (!memory) return sendJson(res, 503, { error: "memory disabled in config" });
          const id = decodeURIComponent(p.slice("/api/memory/".length));
          sendJson(res, 200, { deleted: memory.remove(id) });
          return;
        }

        if (req.method === "POST" && p === "/api/memory/curate") {
          if (!memory) return sendJson(res, 503, { error: "memory disabled in config" });
          const removed = memory.prune({ maxEntries: cfg.memory.maxEntries, dropKinds: ["task"] });
          sendJson(res, 200, { removed, count: memory.count });
          return;
        }

        if (req.method === "GET" && p === "/api/pending") {
          sendJson(res, 200, { items: listPending() });
          return;
        }

        if (req.method === "POST" && p.startsWith("/api/pending/")) {
          const rest = p.slice("/api/pending/".length);
          const slash = rest.lastIndexOf("/");
          const id = decodeURIComponent(slash >= 0 ? rest.slice(0, slash) : rest);
          const action = slash >= 0 ? rest.slice(slash + 1) : "";
          const item = getPending(id);
          if (!item) return sendJson(res, 404, { error: "pending item not found" });
          if (action === "approve") {
            try {
              const label = await applyPendingItem(item, memory);
              removePending(id);
              appendLearning({ at: new Date().toISOString(), task: "(approved)", applied: [label] });
              sendJson(res, 200, { applied: label });
            } catch (err) {
              sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }
            return;
          }
          if (action === "reject") {
            removePending(id);
            appendLearning({ at: new Date().toISOString(), task: "(rejected)", applied: [item.summary] });
            sendJson(res, 200, { rejected: id });
            return;
          }
        }

        if (req.method === "GET" && p === "/api/learning") {
          const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 500);
          sendJson(res, 200, { entries: readLearning(limit) });
          return;
        }

        // ---- Self-evaluation harness + telemetry + datasets ----
        if (req.method === "GET" && p === "/api/eval/suites") {
          const suites = listSuites().map((s) => ({ ...s, lastRun: lastRunForSuite(s.id) ?? null }));
          sendJson(res, 200, { suites, busy: evalBusy(), active: activeSummary() });
          return;
        }

        if (req.method === "POST" && p === "/api/eval/run") {
          if (!registry) return sendJson(res, 503, { error: "التقييم غير متاح في هذه الجلسة" });
          const body = (await readBody(req)) as { suite?: unknown; case?: unknown };
          const ref = typeof body.suite === "string" && body.suite ? body.suite : cfg.evaluation.suite;
          try {
            const suite = loadSuite(ref);
            const { runId } = runSuiteBackground(suite, evalDeps(), {
              caseFilter: typeof body.case === "string" && body.case ? body.case : undefined,
            });
            sendJson(res, 200, { runId, suiteId: suite.id, cases: suite.cases.length });
          } catch (err) {
            sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        if (req.method === "GET" && p === "/api/eval/runs") {
          const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20), 1), 200);
          sendJson(res, 200, { runs: listRuns(limit) });
          return;
        }

        if (req.method === "GET" && p.startsWith("/api/eval/runs/")) {
          const id = decodeURIComponent(p.slice("/api/eval/runs/".length));
          const run = getRun(id);
          if (!run) return sendJson(res, 404, { error: "run not found" });
          sendJson(res, 200, { run, running: activeSummary()?.id === id });
          return;
        }

        if (req.method === "POST" && p === "/api/eval/selfplay") {
          const body = (await readBody(req)) as { runId?: unknown; maxCases?: unknown };
          try {
            const draft = await generateSelfPlayDraft({
              cfg,
              ollama,
              fromRunId: typeof body.runId === "string" && body.runId ? body.runId : undefined,
              maxCases: Number.isFinite(Number(body.maxCases)) ? Number(body.maxCases) : undefined,
            });
            sendJson(res, 200, {
              draftPath: path.basename(draft.draftPath),
              suiteId: draft.suite.id,
              cases: draft.suite.cases.length,
              sourceFailures: draft.sourceFailures,
              preview: draft.suite.cases.slice(0, 3).map((c) => ({ id: c.id, prompt: c.prompt.slice(0, 200) })),
            });
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        if (req.method === "POST" && p === "/api/eval/drafts/install") {
          const body = (await readBody(req)) as { name?: unknown };
          try {
            const installed = installDraft(String(body.name ?? ""));
            sendJson(res, 200, installed);
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        if (req.method === "POST" && p === "/api/eval/export") {
          try {
            const result = await exportDatasets({ cfg });
            sendJson(res, 200, result);
          } catch (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        if (req.method === "GET" && p === "/api/telemetry/summary") {
          const trend = listRuns(20)
            .filter((r) => r.status !== "running")
            .map((r) => ({ id: r.id, suiteId: r.suiteId, at: r.finishedAt, passRate: r.summary.passRate, cases: r.summary.cases }));
          sendJson(res, 200, { ...telemetrySummary(), evalTrend: trend });
          return;
        }

        if (req.method === "GET" && p === "/api/screen/status") {
          sendJson(res, 200, live ? { enabled: cfg.screen.enabled, ...live.status() } : { enabled: false, running: false });
          return;
        }

        if (req.method === "POST" && p === "/api/screen/start") {
          if (!live) return sendJson(res, 503, { error: "screen streaming disabled in config" });
          const body = (await readBody(req)) as { fps?: unknown };
          live.start(body.fps === undefined ? undefined : Number(body.fps));
          sendJson(res, 200, live.status());
          return;
        }

        if (req.method === "POST" && p === "/api/screen/stop") {
          live?.stop();
          sendJson(res, 200, live ? live.status() : { running: false });
          return;
        }

        if (req.method === "GET" && p === "/api/screen/frame") {
          const frame = live?.latest() ?? null;
          if (!frame) {
            res.writeHead(204).end();
            return;
          }
          const buf = Buffer.from(frame.base64, "base64");
          res.writeHead(200, {
            "content-type": frame.mediaType,
            "content-length": buf.length,
            "cache-control": "no-store",
            "x-frame-at": frame.at,
            "x-frame-index": String(frame.index),
          });
          res.end(buf);
          return;
        }

        if (req.method === "GET" && p === "/api/screen/stream") {
          if (!live) {
            res.writeHead(503).end("screen disabled");
            return;
          }
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
          });
          const current = live.latest();
          if (current) {
            res.write(`data: ${JSON.stringify({ type: "frame", data: current.base64, at: current.at, width: current.width, height: current.height, index: current.index })}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify({ type: "status", ...live.status() })}\n\n`);
          }
          const unsub = live.subscribe((frame) => {
            res.write(`data: ${JSON.stringify({ type: "frame", data: frame.base64, at: frame.at, width: frame.width, height: frame.height, index: frame.index })}\n\n`);
          });
          const keepalive = setInterval(() => res.write(": ping\n\n"), 15_000);
          req.on("close", () => {
            clearInterval(keepalive);
            unsub();
          });
          return;
        }

        if (req.method === "GET" && p === "/api/updater") {
          const st = getSettings();
          const repo = (st.githubRepo || process.env.MANUS_GITHUB_REPO || "").trim();
          const effectiveFeed =
            (st.updateFeedUrl && st.updateFeedUrl.trim()) ||
            (repo ? `https://github.com/${repo.replace(/^\/+|\/+$/g, "")}/releases/latest/download/` : "") ||
            (process.env.MANUS_LOCAL_UPDATE_URL || "").trim() ||
            "http://127.0.0.1:8788/";
          sendJson(res, 200, {
            effectiveFeed,
            updateFeedUrl: st.updateFeedUrl ?? "",
            githubRepo: st.githubRepo ?? "",
          });
          return;
        }

        if (req.method === "POST" && p === "/api/updater") {
          const body = (await readBody(req)) as { updateFeedUrl?: unknown; githubRepo?: unknown };
          const patch: { updateFeedUrl?: string; githubRepo?: string } = {};
          if (typeof body.updateFeedUrl === "string") patch.updateFeedUrl = body.updateFeedUrl.trim();
          if (typeof body.githubRepo === "string") patch.githubRepo = body.githubRepo.trim();
          const st = updateSettings(patch);
          const repo = (st.githubRepo || process.env.MANUS_GITHUB_REPO || "").trim();
          const effectiveFeed =
            (st.updateFeedUrl && st.updateFeedUrl.trim()) ||
            (repo ? `https://github.com/${repo.replace(/^\/+|\/+$/g, "")}/releases/latest/download/` : "") ||
            "http://127.0.0.1:8788/";
          sendJson(res, 200, { ok: true, effectiveFeed, updateFeedUrl: st.updateFeedUrl ?? "", githubRepo: st.githubRepo ?? "" });
          return;
        }

        if (req.method === "GET" && p === "/api/settings") {
          sendJson(res, 200, { ...getSettings(), defaultModel: cfg.model });
          return;
        }

        if (req.method === "POST" && p === "/api/settings") {
          const body = (await readBody(req)) as { theme?: unknown; model?: unknown; projectId?: unknown; autoApprove?: unknown };
          const patch: { theme?: "dark" | "light" | "system"; model?: string; projectId?: string | null; autoApprove?: boolean } = {};
          if (body.theme === "dark" || body.theme === "light" || body.theme === "system") patch.theme = body.theme;
          if (typeof body.model === "string") patch.model = body.model;
          if (body.projectId === null || typeof body.projectId === "string") patch.projectId = body.projectId;
          if (typeof body.autoApprove === "boolean") patch.autoApprove = body.autoApprove;
          sendJson(res, 200, updateSettings(patch));
          return;
        }

        // ---- agents (multi-agent): CRUD + selection for /api/chat ----
        if (req.method === "GET" && p === "/api/tools") {
          const names = registry?.names() ?? [];
          const tools = names.map((n) => ({
            name: n,
            description: (registry?.get(n)?.description ?? "").slice(0, 200),
          }));
          sendJson(res, 200, { tools });
          return;
        }

        if (req.method === "GET" && p === "/api/agents") {
          sendJson(res, 200, { agents: listAgents() });
          return;
        }

        if (req.method === "POST" && p === "/api/agents") {
          const body = (await readBody(req)) as { name?: unknown; emoji?: unknown; description?: unknown; instructions?: unknown; model?: unknown; mode?: unknown; effort?: unknown; disabledTools?: unknown };
          const name = typeof body.name === "string" ? body.name.trim() : "";
          if (!name) return sendJson(res, 400, { error: "اسم الوكيل مطلوب" });
          const agent = createAgent({
            name,
            emoji: typeof body.emoji === "string" ? body.emoji : undefined,
            description: typeof body.description === "string" ? body.description : undefined,
            instructions: typeof body.instructions === "string" ? body.instructions : undefined,
            model: typeof body.model === "string" ? body.model : undefined,
            mode: typeof body.mode === "string" ? body.mode : undefined,
            effort: typeof body.effort === "string" ? body.effort : undefined,
            disabledTools: body.disabledTools,
          });
          sendJson(res, 200, { agent });
          return;
        }

        if (p.startsWith("/api/agents/")) {
          const id = decodeURIComponent(p.slice("/api/agents/".length));
          if (req.method === "GET") {
            const agent = getAgent(id);
            if (!agent) return sendJson(res, 404, { error: "الوكيل غير موجود" });
            sendJson(res, 200, { agent });
            return;
          }
          if (req.method === "POST") {
            const body = (await readBody(req)) as { name?: unknown; emoji?: unknown; description?: unknown; instructions?: unknown; model?: unknown; mode?: unknown; effort?: unknown; disabledTools?: unknown };
            const patch: { name?: string; emoji?: string; description?: string; instructions?: string; model?: string | null; mode?: string | null; effort?: string | null; disabledTools?: unknown } = {};
            if (typeof body.name === "string") patch.name = body.name;
            if (typeof body.emoji === "string") patch.emoji = body.emoji;
            if (typeof body.description === "string") patch.description = body.description;
            if (typeof body.instructions === "string") patch.instructions = body.instructions;
            if (body.model === null) patch.model = null;
            else if (typeof body.model === "string") patch.model = body.model;
            if (body.mode === null) patch.mode = null;
            else if (typeof body.mode === "string") patch.mode = body.mode;
            if (body.effort === null) patch.effort = null;
            else if (typeof body.effort === "string") patch.effort = body.effort;
            if (body.disabledTools !== undefined) patch.disabledTools = body.disabledTools;
            const agent = updateAgent(id, patch);
            if (!agent) return sendJson(res, 404, { error: "الوكيل غير موجود" });
            sendJson(res, 200, { agent });
            return;
          }
          if (req.method === "DELETE") {
            sendJson(res, 200, { deleted: deleteAgent(id) });
            return;
          }
        }

        if (req.method === "GET" && p === "/api/projects") {
          sendJson(res, 200, { projects: listProjects() });
          return;
        }
        if (req.method === "POST" && p === "/api/projects") {
          const body = (await readBody(req)) as { name?: unknown; instruction?: unknown };
          const name = typeof body.name === "string" ? body.name.trim() : "";
          if (!name) return sendJson(res, 400, { error: "name required" });
          const project = createProject(name, typeof body.instruction === "string" ? body.instruction : undefined);
          sendJson(res, 200, { project });
          return;
        }

        if (p.startsWith("/api/projects/")) {
          const id = decodeURIComponent(p.slice("/api/projects/".length));
          if (req.method === "POST") {
            const body = (await readBody(req)) as { name?: unknown; instruction?: unknown };
            const patch: { name?: string; instruction?: string } = {};
            if (typeof body.name === "string") patch.name = body.name;
            if (typeof body.instruction === "string") patch.instruction = body.instruction;
            const project = updateProject(id, patch);
            if (!project) return sendJson(res, 404, { error: "project not found" });
            sendJson(res, 200, { project });
            return;
          }
          if (req.method === "DELETE") {
            sendJson(res, 200, { deleted: deleteProjectR(id) });
            return;
          }
          if (req.method === "GET") {
            const project = getProject(id);
            if (!project) return sendJson(res, 404, { error: "project not found" });
            sendJson(res, 200, { project, tasks: listTasks(id).map(({ messages, steps, ...rest }) => ({ ...rest, messageCount: messages.length, stepCount: steps.length })) });
            return;
          }
        }

        if (req.method === "GET" && p === "/api/file") {
          const rel = url.searchParams.get("path") ?? "";
          if (!rel) return sendJson(res, 400, { error: "path required" });
          try {
            const file = taskPath(requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace), rel);
            if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(res, 404, { error: "file not found" });
            const st = fs.statSync(file);
            if (st.size > 2_000_000) return sendJson(res, 413, { error: `file too large (${st.size} bytes)` });
            sendJson(res, 200, { path: rel, size: st.size, content: fs.readFileSync(file, "utf8") });
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        if (req.method === "GET" && p === "/api/browser/state") {
          const taskId = url.searchParams.get("taskId");
          requireTaskWorkspace(taskId, cfg.workspace);
          sendJson(res, 200, executionQueue.snapshot().active === taskId ? getBrowserState() : { running: false, recording: false, pages: [], actions: [], lastTable: null, lastVideoPath: null, lastTracePath: null, traceName: null, traceStartedAt: null });
          return;
        }

        if (req.method === "GET" && p === "/api/media") {
          const rel = url.searchParams.get("path") ?? "";
          if (!rel) return sendJson(res, 400, { error: "path required" });
          try {
            const file = taskPath(requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace), rel);
            if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(res, 404, { error: "not found" });
            const st = fs.statSync(file);
            res.writeHead(200, {
              "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
              "content-length": st.size,
              "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:",
              "x-content-type-options": "nosniff",
              "cache-control": "no-store",
            });
            fs.createReadStream(file).pipe(res);
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        if (req.method === "GET" && p === "/api/files") {
          const rel = (url.searchParams.get("path") ?? "").trim().replace(/^[/\\]+/, "");
          const max = Math.min(Math.max(Number(url.searchParams.get("max") ?? 300), 1), 2000);
          const root = requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace);
          const dir = taskPath(root, rel);
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return sendJson(res, 404, { error: "directory not found" });
          const skipDirs = new Set([
            "node_modules",
            ".git",
            ".screenshots",
            ".browser-recordings",
            ".browser-profile",
            "__pycache__",
            ".next",
            ".expo",
          ]);
          const entries: Array<{ name: string; path: string; dir: boolean; size: number; mtime: string; mtimeMs: number }> = [];
          const scanCap = Math.max(max * 6, 2500);
          const walk = (d: string, depth: number): void => {
            if (entries.length >= scanCap || depth > 5) return;
            let items: fs.Dirent[] = [];
            try {
              items = fs.readdirSync(d, { withFileTypes: true });
            } catch {
              return;
            }
            for (const it of items) {
              if (entries.length >= scanCap) return;
              if (skipDirs.has(it.name) || it.isSymbolicLink()) continue;
              const full = path.join(d, it.name);
              const relPath = path.relative(root, full).split(path.sep).join("/");
              try {
                const st = fs.statSync(full);
                entries.push({
                  name: it.name,
                  path: relPath,
                  dir: it.isDirectory(),
                  size: st.size,
                  mtime: st.mtime.toISOString(),
                  mtimeMs: st.mtimeMs,
                });
              } catch {
                /* ignore */
              }
              if (it.isDirectory()) walk(full, depth + 1);
            }
          };
          walk(dir, 0);
          entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
          const trimmed = entries.slice(0, max).map(({ mtimeMs: _m, ...rest }) => rest);
          sendJson(res, 200, { root: dir, workspaceRoot: root, path: rel, entries: trimmed });
          return;
        }

        if (req.method === "GET" && p === "/api/preview") {
          const root = requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace);
          const current = preview?.status;
          sendJson(res, 200, current?.root && isInside(root, current.root) ? current : { running: false, url: null, root: null, requests: 0, startedAt: null });
          return;
        }

        if (req.method === "POST" && p === "/api/preview") {
          if (!preview) return sendJson(res, 503, { error: "preview unavailable" });
          const body = (await readBody(req)) as { taskId?: unknown; dir?: unknown; port?: unknown };
          try {
            const dir = taskPath(requireTaskWorkspace(body.taskId, cfg.workspace), typeof body.dir === "string" && body.dir ? body.dir : ".");
            const inst = await preview.start(dir, Number(body.port) || undefined);
            sendJson(res, 200, { url: inst.url, root: inst.root });
          } catch (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        if (req.method === "DELETE" && p === "/api/preview") {
          const root = requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace);
          sendJson(res, 200, { stopped: preview?.status.root && isInside(root, preview.status.root) ? preview.stop() : false });
          return;
        }

        if ((p === "/api/studio" && ["GET", "POST"].includes(req.method ?? "")) || (p === "/api/studio/export" && req.method === "GET")) {
          try {
            const body = req.method === "POST" ? await readBody(req, 2_100_000) as { taskId?: unknown; artifact?: unknown; expectedRevision?: unknown } : null;
            const taskId = body?.taskId ?? url.searchParams.get("taskId");
            const root = requireTaskWorkspace(taskId, cfg.workspace);
            const task = getTask(String(taskId))!;
            if (!["write", "data"].includes(getLoamMode(task.mode).id)) return sendJson(res, 403, { error: "Studio is available only in Loam Write and Loam Data" });
            if (body) return sendJson(res, 200, { artifact: saveStudio(root, body.artifact, body.expectedRevision) });
            const artifact = readStudio(root);
            if (p === "/api/studio/export") {
              if (!artifact) return sendJson(res, 404, { error: "No studio artifact to export" });
              const output = await exportStudio(artifact);
              res.writeHead(200, { "content-type": output.contentType, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(output.filename)}`, "cache-control": "no-store" });
              res.end(output.buffer); return;
            }
            return sendJson(res, 200, { artifact });
          } catch (error) {
            if (error instanceof StudioError) return sendJson(res, error.status, { error: error.message, ...(error.status === 409 ? { artifact: error.artifact } : {}) });
            throw error;
          }
        }

        if (req.method === "POST" && p === "/api/tasks/draft") {
          const body = await readBody(req) as { title?: string; mode?: string; agentId?: string; projectId?: string };
          let mode: string;
          try { mode = getLoamMode(body.mode).id; } catch (error) { return sendJson(res, 400, { error: String(error) }); }
          const task = createTask("", body.title || "مهمة جديدة", body.projectId, body.agentId);
          requireTaskWorkspace(task.id, cfg.workspace);
          setTaskMode(task.id, mode);
          setTaskStatus(task.id, "cancelled");
          return sendJson(res, 201, { task: getTask(task.id) });
        }

        if (req.method === "GET" && p === "/api/tasks") {
          const projectFilter = url.searchParams.get("projectId");
          const agentFilter = url.searchParams.get("agentId");
          let list = listTasks(projectFilter === null ? undefined : projectFilter === "none" ? null : projectFilter);
          if (agentFilter !== null) {
            list = agentFilter === "none" ? list.filter((t) => !t.agentId) : list.filter((t) => t.agentId === agentFilter);
          }
          sendJson(res, 200, {
            tasks: list.map(({ messages, steps, ...rest }) => ({ ...rest, messageCount: messages.length, stepCount: steps.length })),
          });
          return;
        }

        if (req.method === "GET" && p.startsWith("/api/tasks/") && p.endsWith("/stream")) {
          const id = decodeURIComponent(p.slice("/api/tasks/".length, -"/stream".length));
          const task = getTask(id);
          if (!task) return sendJson(res, 404, { error: "task not found" });
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
          });
          for (const step of task.steps) {
            res.write(`data: ${JSON.stringify({ type: "step-record", step })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ type: "task-status", status: task.status })}\n\n`);
          const unsub = subscribeTask(id, (event) => {
            res.write(`data: ${redact(JSON.stringify(event))}\n\n`);
          });
          const keepalive = setInterval(() => res.write(": ping\n\n"), 15_000);
          req.on("close", () => {
            clearInterval(keepalive);
            unsub();
          });
          return;
        }

        if (req.method === "GET" && p.startsWith("/api/tasks/")) {
          const id = decodeURIComponent(p.slice("/api/tasks/".length));
          const task = getTask(id);
          if (!task) return sendJson(res, 404, { error: "task not found" });
          const saved = getSavedRun(id);
          sendJson(res, 200, { task, recovery: saved ? {
            resumable: !executionQueue.has(id) && task.status !== "done" && !!task.workspace && path.resolve(saved.workspace) === path.resolve(task.workspace),
            requiresConfirmation: requiresReplayConfirmation(saved),
            completedSteps: saved.checkpoint?.completed.length ?? 0,
          } : null });
          return;
        }

        if (req.method === "GET" && p === "/api/schedules") {
          sendJson(res, 200, { schedules: listSchedules() });
          return;
        }

        if (req.method === "POST" && p === "/api/schedules") {
          const body = (await readBody(req)) as { prompt?: unknown; intervalSeconds?: unknown };
          const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
          const intervalSeconds = Number(body.intervalSeconds ?? 0);
          if (!prompt) return sendJson(res, 400, { error: "prompt required" });
          if (!Number.isFinite(intervalSeconds) || intervalSeconds < 30) return sendJson(res, 400, { error: "intervalSeconds must be >= 30" });
          const schedule = addSchedule(prompt, intervalSeconds);
          sendJson(res, 200, { schedule });
          return;
        }

        if (req.method === "DELETE" && p.startsWith("/api/schedules/")) {
          const id = decodeURIComponent(p.slice("/api/schedules/".length));
          sendJson(res, 200, { deleted: deleteSchedule(id) });
          return;
        }

        if (req.method === "POST" && p === "/api/chat") {
          const body = (await readBody(req)) as {
            prompt?: unknown;
            taskId?: unknown;
            title?: unknown;
            model?: unknown;
            projectId?: unknown;
            attachments?: unknown;
            mode?: unknown;
            effort?: unknown;
            agentId?: unknown;
          };
          const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
          if (!prompt) return sendJson(res, 400, { error: "prompt required" });
          let taskId = typeof body.taskId === "string" && body.taskId ? body.taskId : undefined;
          const title = typeof body.title === "string" ? body.title : undefined;
          const model = typeof body.model === "string" && body.model ? body.model : undefined;
          const projectId = body.projectId === null ? null : typeof body.projectId === "string" ? body.projectId : undefined;
          let mode: string;
          try { mode = getLoamMode(typeof body.mode === "string" ? body.mode : (taskId ? getTask(taskId)?.mode : undefined)).id; }
          catch (error) { return sendJson(res, 400, { error: String(error) }); }
          const effort = typeof body.effort === "string" && body.effort ? body.effort : undefined;
          const agentId = typeof body.agentId === "string" && body.agentId ? body.agentId : undefined;

          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
          });

          const emit = (event: AgentEvent): void => {
            res.write(`data: ${redact(JSON.stringify(event))}\n\n`);
          };

          try {
            if (!taskId) taskId = createTask(prompt, title, projectId, agentId).id;
            const root = requireTaskWorkspace(taskId, cfg.workspace);
            setTaskMode(taskId, mode);
            const attachmentsBlock = await buildAttachmentsBlock(body.attachments, root);
            const result = await runTask({
              prompt: attachmentsBlock ? `${prompt}\n\n${attachmentsBlock}` : prompt,
              emit,
              taskId,
              title,
              model,
              projectId,
              mode,
              effort,
              agentId,
            });
            res.write(`data: ${JSON.stringify({ type: "task", taskId: result.taskId })}\n\n`);
          } catch (err) {
            res.write(`data: ${JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) })}\n\n`);
          }
          res.end();
          return;
        }

        if (req.method === "GET" && p === "/api/queue") {
          return sendJson(res, 200, executionQueue.snapshot());
        }
        if (req.method === "POST" && p.startsWith("/api/tasks/") && p.endsWith("/resume")) {
          const id = decodeURIComponent(p.slice("/api/tasks/".length, -"/resume".length));
          const task = getTask(id);
          const saved = getSavedRun(id);
          if (!task) return sendJson(res, 404, { error: "task not found" });
          if (!saved || task.status === "done" || executionQueue.has(id)) return sendJson(res, 409, { error: "task cannot be resumed" });
          const body = await readBody(req) as { retryInterruptedStep?: boolean };
          if (requiresReplayConfirmation(saved) && body.retryInterruptedStep !== true) {
            return sendJson(res, 409, { error: "قد تكون الخطوة المتوقفة نفذت إجراءات بالفعل. يلزم تأكيد إعادة المحاولة.", requiresConfirmation: true });
          }
          if (!fs.existsSync(saved.workspace)) return sendJson(res, 409, { error: "saved workspace is unavailable" });
          if (path.resolve(saved.workspace).toLowerCase() !== path.resolve(requireTaskWorkspace(id, cfg.workspace)).toLowerCase()) {
            return sendJson(res, 409, { error: "لا يمكن استئناف التنفيذ القديم في المساحة المشتركة. ابدأ تشغيلاً جديداً معزولاً." });
          }
          void runTask({ taskId: id, prompt: saved.prompt, resume: true, retryInterruptedStep: body.retryInterruptedStep === true, emit: () => {} })
            .catch((error) => log.warn(`resume ${id}: ${String(error)}`));
          return sendJson(res, 202, { taskId: id, status: getTask(id)?.status });
        }
        if (req.method === "POST" && p.startsWith("/api/tasks/") && p.endsWith("/cancel")) {
          const id = decodeURIComponent(p.slice("/api/tasks/".length, -"/cancel".length));
          const task = getTask(id);
          if (!task) return sendJson(res, 404, { error: "task not found" });
          const ok = cancelRunSignal(id);
          log.info(`cancel requested for task ${id}: signal=${ok}`);
          sendJson(res, 200, { ok, note: ok ? "سيُوقف التنفيذ بين الخطوات" : "بدون تشغيل جارٍ لهذه المهمة" });
          return;
        }

        // ---- Upload a local file into <workspace>/uploads (drop-zone) ----
        if (req.method === "POST" && p === "/api/upload") {
          const rawName = url.searchParams.get("name") ?? "upload.bin";
          const safe = path.basename(rawName).replace(/[^\w.\u0600-\u06ff -]+/g, "_").slice(0, 120) || "upload.bin";
          const root = requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace);
          const dir = taskPath(root, "uploads");
          fs.mkdirSync(dir, { recursive: true });
          const buf = await readRawBody(req);
          if (buf.length === 0) return sendJson(res, 400, { error: "empty upload" });
          const abs = taskPath(root, path.join("uploads", `${Date.now()}-${safe}`));
          fs.writeFileSync(abs, buf);
          sendJson(res, 200, {
            name: safe,
            bytes: buf.length,
            path: path.relative(root, abs).split(path.sep).join("/"),
          });
          return;
        }

        // ---- Skills (local skills/ + aitmpl.com catalog) ----
        if (req.method === "GET" && p === "/api/skills") {
          sendJson(res, 200, {
            skills: listSkillRecords().map((r) => ({ name: r.name, description: r.description })),
          });
          return;
        }

        if (req.method === "GET" && p === "/api/skills/catalog") {
          const q = url.searchParams.get("q") ?? "";
          const limit = Math.min(Number(url.searchParams.get("limit") ?? 40) || 40, 200);
          const describe = Math.min(Number(url.searchParams.get("describe") ?? 8) || 0, 25);
          const refresh = url.searchParams.get("refresh") === "1";
          try {
            sendJson(res, 200, await searchCatalog({ query: q, limit, describe, refresh }));
          } catch (err) {
            sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        if (req.method === "GET" && p === "/api/skills/one") {
          const view = readSkillFile(url.searchParams.get("name") ?? "");
          if (!view) return sendJson(res, 404, { error: "skill not found" });
          sendJson(res, 200, view);
          return;
        }

        if (req.method === "POST" && (p === "/api/skills" || p === "/api/skills/create")) {
          const body = (await readBody(req)) as Record<string, unknown>;
          const r = applySkill("skill_create", body);
          return sendJson(res, r.ok ? 200 : 400, { ok: r.ok, message: r.content });
        }

        if (req.method === "POST" && p === "/api/skills/update") {
          const body = (await readBody(req)) as { name?: unknown; description?: unknown; body?: unknown };
          const name = typeof body.name === "string" ? body.name : "";
          const current = readSkillFile(name);
          if (!current) return sendJson(res, 404, { ok: false, message: "skill not found" });
          const description = typeof body.description === "string" ? body.description : current.description;
          const text = typeof body.body === "string" ? body.body : current.body;
          const r = applySkill("skill_patch", { name, content: buildSkillFile(current.name, description, text) });
          return sendJson(res, r.ok ? 200 : 400, { ok: r.ok, message: r.content });
        }

        if (req.method === "POST" && p === "/api/skills/delete") {
          const body = (await readBody(req)) as Record<string, unknown>;
          const r = applySkill("skill_delete", body);
          return sendJson(res, r.ok ? 200 : 400, { ok: r.ok, message: r.content });
        }

        if (req.method === "POST" && p === "/api/skills/install") {
          const body = (await readBody(req)) as { id?: unknown; force?: unknown };
          try {
            const r = await installFromCatalog({ id: String(body.id ?? ""), force: body.force === true });
            sendJson(res, 200, r);
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        // ---- Persistent memory dashboard (backed by the memory-skills MCP server) ----
        if (req.method === "GET" && p === "/api/brain") {
          const bounded = (raw: string | null, def: number, max: number): number => {
            const n = Number(raw);
            return Math.min(Math.max(Number.isFinite(n) && n > 0 ? Math.round(n) : def, 1), max);
          };
          const call = await memorySkillsCall("dashboard", {
            episodes: bounded(url.searchParams.get("episodes"), 10, 50),
            facts: bounded(url.searchParams.get("facts"), 10, 50),
            skills: bounded(url.searchParams.get("skills"), 20, 100),
          });
          if (!call.ok) return sendJson(res, 503, { error: call.error });
          try {
            sendJson(res, 200, JSON.parse(call.text));
          } catch {
            sendJson(res, 200, { raw: call.text });
          }
          return;
        }

        if (req.method === "GET" && p === "/api/brain/skill") {
          const call = await memorySkillsCall("skill_get", { name: url.searchParams.get("name") ?? "" });
          if (!call.ok) return sendJson(res, call.error.includes("not running") ? 503 : 404, { error: call.error });
          sendJson(res, 200, { content: call.text });
          return;
        }

        if (req.method === "POST" && p === "/api/brain/improve") {
          const body = (await readBody(req)) as { name?: unknown; lessons?: unknown };
          const lessons = Array.isArray(body.lessons) ? body.lessons.map((l) => String(l)) : [];
          const call = await memorySkillsCall("skill_improve", { name: String(body.name ?? ""), lessons });
          if (!call.ok) return sendJson(res, 400, { error: call.error });
          sendJson(res, 200, { message: call.text });
          return;
        }

        // ---- MiroFish Swarm Intelligence conversational endpoints ----
        if (req.method === "GET" && p === "/api/mirofish/session") {
          return sendJson(res, 200, { ok: true, session: loadActiveMirofishSession(requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace)) });
        }

        if (req.method === "GET" && p === "/api/frontier/status") {
          return sendJson(res, 200, await getFrontierBridgeStatus(cfg.workspace));
        }

        if (req.method === "GET" && p === "/api/mode/detect") {
          const q = url.searchParams.get("q") ?? "";
          if (!q.trim()) return sendJson(res, 400, { error: "q required" });
          try {
            const info = await detectFrontierMode(q);
            return sendJson(res, 200, info ?? { mode: "general", label: "General Workspace Mode", labelAr: "المود العام لمساحة العمل", reason: "" });
          } catch (err) {
            return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
        }

        // ---- Per-Mode UI: list all 27 modes with their UI identity ----
        if (req.method === "GET" && p === "/api/modes") {
          try {
            const list = await getFrontierModesUi(cfg.workspace, deps.registry?.names() ?? []);
            return sendJson(res, 200, list);
          } catch (err) {
            return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
        }

        // ---- Per-Mode UI: switch the active frontier mode (clicked option) ----
        if (req.method === "POST" && p === "/api/mode/switch") {
          const body = (await readBody(req)) as { mode?: unknown; reason?: unknown };
          const mode = String(body.mode ?? "").trim();
          if (!mode) return sendJson(res, 400, { error: "mode required" });
          try {
            const result = await switchFrontierMode(cfg.workspace, mode, String(body.reason ?? "ui switch"));
            if (!result.ok) return sendJson(res, 400, { error: result.error ?? "switch failed" });
            return sendJson(res, 200, result);
          } catch (err) {
            return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
        }

        if (req.method === "POST" && p === "/api/mirofish/chat") {
          const body = (await readBody(req)) as { message?: unknown; target?: unknown; maxRounds?: unknown; injectedVariable?: unknown };
          const out = runConversationalMirofish(requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace), {
            message: String(body.message ?? ""),
            ...(typeof body.target === "string" && body.target ? { target: body.target } : {}),
            ...(typeof body.maxRounds === "number" ? { maxRounds: body.maxRounds } : {}),
            ...(typeof body.injectedVariable === "string" && body.injectedVariable ? { injectedVariable: body.injectedVariable } : {}),
          });
          return sendJson(res, 200, out);
        }

        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      } catch (err) {
        log.error(`http error ${req.method} ${p}: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          const message = err instanceof Error ? err.message : String(err);
          const status = message === "task not found" ? 404 : /taskId required|path outside task|links are not allowed|invalid task id|Unknown Loam mode/.test(message) ? 400 : 500;
          sendJson(res, status, { error: message });
        }
        else res.end();
      }
    })();
  });

  return new Promise((resolve) => {
    server.listen(cfg.server.port, cfg.server.host, () => resolve(server));
  });
}
