import http from "node:http";
import { startSseHeartbeat } from './sseHeartbeat.js';
import { TimelineService } from '../creative/timeline.js';
import { MobileError, mobileHistory, readMobile, saveMobile, travelMobile } from '../mobile/store.js';
import { buildMobile } from '../mobile/build.js';
import { exportMobile, mobileHtml } from '../mobile/export.js';
import {handleMobileWorkbench} from '../mobile/workbench-http.js';
import {handleMobileLocalServices} from '../mobile/local-services-http.js';
import {sourceExport} from '../mobile/source.js';
import { androidEnvironment, androidBuildStatus, startAndroidBuild, cancelAndroidBuild, androidArtifact } from '../mobile/android/build.js';
import { createHash, randomUUID } from "node:crypto";
import { readScene, saveScene, CreativeError, validateGlb, MAX_GLB_BYTES } from "../creative/store.js";
import { requireTaskWorkspace, taskPath } from "./taskWorkspace.js";
import { getLoamMode } from "../modes/catalog.js";
import { readStudio, saveStudio, validateStudio, StudioError, type StudioArtifact } from "../studio/store.js";
import { exportStudio } from "../studio/export.js";
import { renderWordPreview } from "../studio/word-preview.js";
import { renderSlidePreview } from "../studio/slide-preview.js";
import { interactiveWordCopy } from "../studio/word-preview-links.js";
import { importStudio } from "../studio/import.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import nodeChildProcess from "node:child_process";
import { ROOT, UI_DIR, DATA_DIR, type Config } from "../config.js";
import type { OllamaClient } from "../ollama.js";
import type { AgentEvent, Emit } from "../agent/events.js";
import { log, redact } from "../log.js";
import { validateLocalToken, setLocalAuthUserDataDir } from "../security/localAuth.js";
import { isInside, resolveRead, resolveWrite } from "../policy/paths.js";
import type { MemoryStore } from "../memory/store.js";
import { getPending, listPending, removePending, type PendingItem } from "./pending.js";
import { applySkill, buildSkillFile, listSkillRecords, readSkillFile } from "../tools/skills.js";
import { extractOfficeText, OFFICE_EXT, prepareParser as buildPdfParser } from "../tools/attachments.js";
import { loadHooksConfig, saveWorkspaceHooks, type HooksConfig } from "../policy/hooks.js";
import { outlineWorkspacePath, queryWorkspaceSymbols } from "../tools/symbols.js";
import { buildPentestMarkdownReport, PENTEST_CHECKS, runPentestCheck, scanWorkspaceRoutesAndRisks } from "../tools/pentest.js";
import { AssessmentError, startAssessment, listAssessments, readAssessment, cancelAssessment, assessmentReport, updateFinding, retestAssessment } from "../security/assessments.js";
import { SECURITY_CAPABILITIES } from '../security/diagnostics.js';
import { sarif } from "../security/findings.js";
import {prepareRepair,changeRepair,listRepairs} from '../security/repairs.js';
import { readBrowserArtifact } from "../security/browser.js";
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
import { createAgent, deleteAgent, getAgent, listAgents, listAgentsWithChatMeta, reorderAgents, sanitizeAvatarFields, setAgentArchived, setAgentHidden, setAgentPinned, updateAgent } from "./agents.js";
import { handleScratchpadRoutes } from "./routes/scratchpad.js";
import { handleDesignStudioRoutes } from "./routes/designStudio.js";
import { handleSchedulesRoutes } from "./routes/schedules.js";
import { handleAgentThreadRoutes } from "./routes/agentThreads.js";
import { handleWorkspaceVideoRoutes } from "./routes/workspaceVideo.js";
import { handleCraftRoutes } from "./routes/craft.js";
import { handleInstructionsRoutes } from "./routes/instructions.js";
import { handleAgentSpawnRoutes } from "./routes/agentSpawn.js";
import { handleAutoVideoRoutes } from "./routes/autoVideo.js";
import { handleLiveViewRoutes } from "./routes/liveView.js";
import { handleTranscriptRoutes } from "./routes/transcript.js";
import { handleMarketplaceRoutes } from "./routes/marketplace.js";
import { handlePersonalizationRoutes } from "./routes/personalization.js";
import { handleApiKeysRoutes } from "./routes/apiKeys.js";
import { handleDataControlsRoutes } from "./routes/dataControls.js";
import { handleMemorySkillsRoutes } from "./routes/memorySkills.js";
import { handleApprovalRuleRoutes } from "./routes/approvalRules.js";
import { handleGrokbotBridgeRoutes } from "./routes/grokbotBridge.js";
import { handleRetryLastRoutes } from "./routes/retryLast.js";
import { handleShareRoutes } from "./routes/shares.js";
import { handleProjectContextRoutes } from "./routes/projectContext.js";
import { handleVoiceRoutes } from "./routes/voice.js";
import { handleConnectorsRoutes } from "./routes/connectors.js";
import { handleWikiRoutes } from "./routes/wiki.js";
import { importGrokbotBundle, sanitizeGrokbotBundle } from "./grokbotImport.js";
import { isValidTimezone } from "./scheduleTime.js";
import { getWorkModesUi, normalizeWorkMode, resolveCompanionCapabilities } from "./companionGateway.js";
import { DEVICE_TEMPLATES, deviceManager, getDevice, listDevices, readJournal } from "./companionDevices.js";
import { remember, listMemory, editMemory, supersedeMemory, forget, exportMemory, importMemory } from "./companionMemory.js";
import { appendVoiceTurn, listVoiceTurns, clearVoiceTranscript, transcribeAudio } from "./voiceTranscript.js";
import { createWatchRoutine, watchSchedules, stopWatcher } from "./fileWatchers.js";
import { AGENT_TEMPLATES, getAgentTemplate, sanitizeBundle, writeBundleFile, type CompanionBundle } from "./agentTemplates.js";
import { agentIntegrationGrants, saveAgentIntegrationGrants } from "../tools/integrations.js";
import { readTelemetry } from "../telemetry/store.js";
import { setSecret, listSecrets, deleteSecret } from "./secretsVault.js";
import { createApproval, decideApproval, getApproval, listApprovals } from "./approvals.js";
import { setTaskAgent } from "./db.js";
import { subscribeTask } from "./streams.js";
import { videoStudioRelay, type VideoStudioResult } from "./videoStudioRelay.js";
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
import { SwarmService, SwarmError } from "../swarm/service.js";
import type { McpToolset } from "../tools/mcp.js";
import { integrationCatalog, integrationGrants, saveIntegrationGrants } from '../tools/integrations.js';

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
  workMode?: string;
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

/** A ":cloud"-suffixed model may be served verbatim by the local Ollama (router
 *  setups register the full name); only demand a cloudModel.apiKey when Ollama
 *  does not actually have it — otherwise the request dies before it starts. */
const ollamaTagCache = new Map<string, { names: string[]; at: number }>();
async function cloudSuffixedModelServedByOllama(model: string): Promise<boolean> {
  const baseUrl = process.env.OLLAMA_HOST && /^http/.test(process.env.OLLAMA_HOST) ? process.env.OLLAMA_HOST : "http://127.0.0.1:11434";
  const cached = ollamaTagCache.get(baseUrl);
  const names = cached && Date.now() - cached.at < 60_000 ? cached.names : await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(4_000) })
    .then((r) => (r.ok ? r.json() : { models: [] }))
    .then((d: { models?: Array<{ name?: string }> }) => (d.models ?? []).map((m) => (m.name ?? "").trim()))
    .catch(() => [] as string[]);
  if (!cached || Date.now() - cached.at >= 60_000) ollamaTagCache.set(baseUrl, { names, at: Date.now() });
  return names.includes(model);
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

const NEXT_OUT = path.join(ROOT, "packages", "web", "out");

/**
 * Serve a file from the Next.js static export (packages/web/out). Used for the
 * public share replay page and its /_next assets so a copied share link opens
 * in any browser, not only inside the desktop's app:// protocol.
 */
function serveNextExport(res: http.ServerResponse, urlPath: string): void {
  const rel = urlPath.replace(/^\/+/, "");
  const file = path.resolve(NEXT_OUT, rel);
  if (!file.startsWith(path.resolve(NEXT_OUT))) {
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
  const timeline = new TimelineService(cfg.workspace);
  const memory = deps.memory;
  const live = deps.screenLive;
  const preview = deps.preview;
  const registry = deps.registry;
  const swarm = registry ? new SwarmService({ cfg, ollama, tools: registry }) : null;
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
        // Public endpoints are exempt from the install token; everything else on the
        // loopback server must carry the token injected by the Electron main process.
        const localAuthDir = process.env.LOAM_LOCAL_TOKEN_DIR || DATA_DIR;
        setLocalAuthUserDataDir(localAuthDir);
        const publicPaths = new Set(["/api/health", "/api/identity"]);
        const isStatic = req.method === "GET" && (p === "/" || MIME[path.extname(p).toLowerCase()] !== undefined);
        // The public share replay feed (GET /api/share/:token) is anonymous by
        // design; POST/DELETE stay behind the install token like every /api route.
        const isPublicShare = req.method === "GET" && /^\/api\/share\/[A-Za-z0-9_-]+$/.test(p);
        // The share replay page and its static assets are public like the feed.
        const isNextStatic = req.method === "GET" && (p === "/share" || p.startsWith("/share/") || p.startsWith("/_next/"));
        if (!isStatic && !isPublicShare && !isNextStatic && !publicPaths.has(p)) {
          const token =
            typeof req.headers["x-loam-local-token"] === "string"
              ? req.headers["x-loam-local-token"]
              : undefined;
          if (process.env.LOAM_AUTH_DISABLED !== "true" && !validateLocalToken(localAuthDir, token)) {
            sendJson(res, 401, { error: "unauthenticated", message: "missing or invalid local auth token" });
            return;
          }
        }

        if (await timeline.handle(req, res, url)) return;
        if (p === '/api/integrations') {
          res.setHeader('cache-control', 'no-store');
          if (!registry) return sendJson(res, 503, { error: 'Integrations unavailable' });
          if (req.method === 'GET') {
            const taskId = url.searchParams.get('taskId');
            if (taskId && !getTask(taskId)) return sendJson(res, 404, { error: 'Task not found' });
            return sendJson(res, 200, { tools: integrationCatalog(registry), enabled: taskId ? integrationGrants(taskId) : [] });
          }
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
          if ((req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site') return sendJson(res, 403, { error: 'Same-origin requests required' });
          const body = await readBody(req) as { taskId?: unknown; enabled?: unknown };
          if (typeof body.taskId !== 'string' || !Array.isArray(body.enabled) || body.enabled.some(n => typeof n !== 'string')) return sendJson(res, 400, { error: 'taskId and enabled tools are required' });
          try {
            saveIntegrationGrants(body.taskId, body.enabled as string[], registry);
            return sendJson(res, 200, { enabled: integrationGrants(body.taskId) });
          } catch (error) { return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        }
        if (p === '/api/mobile' || p.startsWith('/api/mobile/')) {
          res.setHeader('cache-control', 'no-store');
          if (!['GET', 'POST'].includes(req.method ?? '')) return sendJson(res, 405, { error: 'Method not allowed' });
          if (req.method === 'POST' && ((req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site')) return sendJson(res, 403, { error: 'Same-origin requests required' });
          try {
            if(await handleMobileLocalServices(req,res,url,cfg.workspace))return;
            if(await handleMobileWorkbench(req,res,url,cfg.workspace))return;
            if (p === '/api/mobile/projects' && req.method === 'GET') {
              const projects = listTasks().filter(t => t.mode === 'build' && t.workspace).flatMap(t => {
                try { const project = readMobile(t.workspace!); return project ? [{ taskId: t.id, title: project.title, revision: project.revision }] : []; } catch { return []; }
              });
              return sendJson(res, 200, { projects });
            }
            if (p === '/api/mobile/android/environment' && req.method === 'GET') {
              const { ready, checks, toolchain } = androidEnvironment();
              return sendJson(res, 200, { ready, checks, toolchain });
            }
            if (!['/api/mobile', '/api/mobile/preview', '/api/mobile/export', '/api/mobile/build', '/api/mobile/undo', '/api/mobile/redo', '/api/mobile/android', '/api/mobile/android/build', '/api/mobile/android/cancel', '/api/mobile/android/artifact'].includes(p)) return sendJson(res, 404, { error: 'Not found' });
            const mutation = ['/api/mobile/build', '/api/mobile/undo', '/api/mobile/redo', '/api/mobile/android/build', '/api/mobile/android/cancel'].includes(p);
            if ((req.method === 'POST' && !mutation && p !== '/api/mobile') || (mutation && req.method !== 'POST')) return sendJson(res, 405, { error: 'Method not allowed' });
            let body: Record<string, unknown> | null = null;
            if (req.method === 'POST') {
              if (!req.headers['content-type']?.startsWith('application/json')) return sendJson(res, 415, { error: 'JSON required' });
              try { body = await readBody(req, 3_000_000) as Record<string, unknown>; } catch { return sendJson(res, 400, { error: 'Invalid JSON or size limit exceeded' }); }
              if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'Expected object' });
            }
            const taskId = body?.taskId ?? url.searchParams.get('taskId');
            if (typeof taskId !== 'string' || !taskId) return sendJson(res, 400, { error: 'taskId required' });
            const task = getTask(taskId);
            if (!task) return sendJson(res, 404, { error: 'Task not found' });
            if (task.mode !== 'build') return sendJson(res, 403, { error: 'Mobile studio requires a build task' });
            const root = requireTaskWorkspace(taskId, cfg.workspace);
            if (p === '/api/mobile/android') return sendJson(res, 200, androidBuildStatus(root, url.searchParams.get('buildId') || undefined));
            if (body && p === '/api/mobile/android/build') return sendJson(res, 202, { build: await startAndroidBuild(root, taskId, body.expectedRevision) });
            if (body && p === '/api/mobile/android/cancel') {
              if (typeof body.buildId !== 'string') throw new MobileError('buildId required');
              return sendJson(res, 202, cancelAndroidBuild(root, body.buildId));
            }
            if (p === '/api/mobile/android/artifact') {
              const kind = url.searchParams.get('kind'), id = url.searchParams.get('buildId');
              if (!id || (kind !== 'apk' && kind !== 'source')) throw new MobileError('buildId and kind (apk/source) required');
              const buffer = await androidArtifact(root, id, kind);
              res.writeHead(200, { 'content-type': kind === 'apk' ? 'application/vnd.android.package-archive' : 'application/zip', 'content-disposition': `attachment; filename="loam-android-${kind === 'apk' ? 'debug.apk' : 'source.zip'}"` });
              res.end(buffer); return;
            }
            if (body && p === '/api/mobile/build') {
              if (typeof body.brief !== 'string' || body.brief.trim().length < 10 || body.brief.length > 12000) throw new MobileError('اكتب طلبًا بين 10 و12000 حرف.');
              if (body.model !== undefined && (typeof body.model !== 'string' || body.model.length > 200)) throw new MobileError('Invalid model');
              if (body.operation !== undefined && body.operation !== 'polish' && body.operation !== 'review-data') throw new MobileError('Invalid mobile operation');
              if (body.allowNavigationChanges !== undefined && typeof body.allowNavigationChanges !== 'boolean') throw new MobileError('Invalid navigation change option');
              const selection = body.selection as { screenId: string; blockId: string } | undefined;
              if (selection && (typeof selection.screenId !== 'string' || typeof selection.blockId !== 'string')) throw new MobileError('Invalid selection');
              const controller = new AbortController();
              res.on('close', () => controller.abort());
              res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' });
              const emit = (event: Record<string, unknown>) => { if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
              const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15000);
              try { await buildMobile({ root, model: (body.model as string) || cfg.model, brief: body.brief, expectedRevision: body.expectedRevision, allowNavigationChanges: body.allowNavigationChanges===true, operation: body.operation as 'polish' | 'review-data' | undefined, selection, ollama, signal: controller.signal, emit }); }
              catch (error) { emit({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
              finally { clearInterval(heartbeat); res.end(); }
              return;
            }
            if (body) {
              const project = p === '/api/mobile/undo' || p === '/api/mobile/redo' ? travelMobile(root, body.expectedRevision, p.endsWith('undo') ? 'undo' : 'redo') : saveMobile(root, body.project, body.expectedRevision);
              return sendJson(res, 200, { project, history: mobileHistory(root) });
            }
            const project = readMobile(root);
            if (p === '/api/mobile') return sendJson(res, 200, { project, history: mobileHistory(root) });
            if (!project) return sendJson(res, 404, { error: 'Save a project first' });
            if (p === '/api/mobile/preview') {
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'self'; form-action 'none'; base-uri 'none'" });
              res.end(mobileHtml(project, 'loam-mobile-' + taskId, url.searchParams.get('screen') ?? undefined)); return;
            }
            const buffer = await sourceExport(root, taskId);
            res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="mobile-source.zip"' }); res.end(buffer); return;
          } catch (error) { if (error instanceof MobileError) return sendJson(res, error.status, { error: error.message }); throw error; }
        }
        if (p === "/api/swarm/runs" || p.startsWith("/api/swarm/runs/")) {
          res.setHeader("cache-control", "no-store");
          if (!swarm) return sendJson(res, 503, { error: "محرك الفريق غير متاح في هذه الجلسة" });
          // These endpoints execute tools; browser mutations must originate in this app.
          if (req.method !== "GET") {
            const origin = req.headers.origin;
            if ((origin && origin !== `http://${req.headers.host}`) || req.headers["sec-fetch-site"] === "cross-site") {
              return sendJson(res, 403, { error: "طلبات التشغيل مسموحة من التطبيق فقط" });
            }
            if (!req.headers["content-type"]?.startsWith("application/json")) {
              return sendJson(res, 415, { error: "application/json required" });
            }
          }
          try {
            if (p === "/api/swarm/runs") {
              if (req.method === "GET") return sendJson(res, 200, { runs: swarm.list() });
              if (req.method === "POST") {
                let body: unknown;
                try { body = await readBody(req, 80_000); }
                catch { return sendJson(res, 400, { error: "Invalid JSON request" }); }
                if (!body || typeof body !== "object" || Array.isArray(body)) return sendJson(res, 400, { error: "Expected an object" });
                return sendJson(res, 201, { run: swarm.create(body as Parameters<SwarmService["create"]>[0]) });
              }
              return sendJson(res, 405, { error: "Method not allowed" });
            }
            const match = /^\/api\/swarm\/runs\/([a-zA-Z0-9_-]+)(?:\/(cancel|retry|resume|artifacts|preview|preview\/stop))?$/.exec(p);
            if (!match) return sendJson(res, 404, { error: "Run endpoint not found" });
            const id = match[1]!;
            if (req.method === "GET" && !match[2]) return sendJson(res, 200, { run: swarm.get(id) });
            if (req.method === "GET" && match[2] === "artifacts") return sendJson(res, 200, { artifacts: swarm.artifacts(id) });
            if (req.method === "POST" && match[2] === "cancel") return sendJson(res, 200, { run: swarm.cancel(id) });
            if (req.method === "POST" && match[2] === "retry") return sendJson(res, 202, { run: swarm.retry(id) });
            if (req.method === "POST" && match[2] === "resume") return sendJson(res, 202, { run: swarm.resume(id) });
            if (req.method === "POST" && match[2] === "preview") return sendJson(res, 200, { preview: await swarm.preview(id) });
            if (req.method === "POST" && match[2] === "preview/stop") return sendJson(res, 200, { ...(await swarm.stopPreview(id)) });
            return sendJson(res, 405, { error: "Method not allowed" });
          } catch (error) {
            if (error instanceof SwarmError) return sendJson(res, error.status, { error: error.message });
            throw error;
          }
        }
        if (req.method === "GET" && !p.startsWith("/vendor/") && (p === "/" || MIME[path.extname(p).toLowerCase()] !== undefined)) {
          serveStatic(res, p);
          return;
        }

        // Public share replay (option #11): serve the Next.js export so a copied
        // link opens in a browser. /share/<token> and /share?t=<token> both land
        // on the same replay page, which reads the token from path or query.
        if (req.method === "GET" && (p === "/share" || p.startsWith("/share/"))) {
          serveNextExport(res, "/share.html");
          return;
        }
        if (req.method === "GET" && p.startsWith("/_next/")) {
          serveNextExport(res, p);
          return;
        }

        if (req.method === "GET" && p === "/api/models") {
          try {
            const models = await ollama.listModels();
            sendJson(res, 200, { models });
          } catch (err) {
            log.warn(`models list failed: ${err instanceof Error ? err.message : String(err)}`);
            sendJson(res, 200, { models: [], providerError: "model provider unavailable" });
          }
          return;
        }

        if (req.method === "GET" && p === "/api/health") {
          sendJson(res, 200, {
            ok: true,
            provider: cfg.model.endsWith(":cloud") ? "cloud" : "ollama",
            model: cfg.model,
            tools: registry?.names().length ?? 0,
            sessions: listTasks().length,
            version: process.env.npm_package_version ?? "0.0.0",
          });
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

        if (req.method === "GET" && p === "/api/bot/capabilities") {
          sendJson(res, 200, { revision: 11, mandatoryFinalVerification: true, bufferedCompletion: true,
            taskToolScope: { explicitFileOnly: true, checkpointResume: true, languageCoverage: "limited-explicit-ar-en-commands" },
            acceptanceIntegrity: { freezeAt: "explicit-user-contract-or-first-final-verification", explicitUserContractAtStart: true, explicitCommandLanguages: ["ar", "en"], preservesRepairChecks: true, orchestratorCheckpointResume: true, independentlyAuthored: true, independentMaxScenarios: 4, independentMandatoryForApplications: true, independentCheckpointResume: true },
            creativeVerification: { renderer: "actual-studio", savedCamera: true, framedView: true, optionalMotionSample: true, fullAnimationValidation: false, visualReview: true },
            applicationVerification: { contract: "app-verification.json", runtime: "isolated-playwright", viewports: ["desktop", "mobile"], visualReview: true, visualReviewCoverage: { allCapturedScreenshots: true, maxImagesPerBatch: 12, maxConcurrentBatches: 2 }, network: "local-only", backendApplications: true, expectedHttpResponses: true,
              maxScenarios: 12, sqliteChecks: { readOnly: true, declarative: true, maxChecksPerScenario: 4, maxRows: 100, optInContract: true },
              apiChecks: { declarative: true, exactJsonResponse: true, maxJsonCharacters: 16000, maxGroups: 8, maxConcurrentRequests: 4, maxRequestsPerScenario: 16, optInContract: true },
              backendRuntime: { type: "node", isolation: "docker-network-none", requiredLocalImage: "node:22-alpine", externalPackages: false, externalServices: false, freshStatePerScenario: true, processRestart: true, maxRestartsPerScenario: 2, containerDeletionDurability: false } },
            visualModel: cfg.vision.model || cfg.model });
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

        if (p === "/api/security/assessments" || p.startsWith("/api/security/assessments/")) {
          res.setHeader("cache-control", "no-store");
          if (req.method !== "GET") {
            const origin = req.headers.origin;
            if ((origin && origin !== `http://${req.headers.host}`) || req.headers["sec-fetch-site"] === "cross-site") return sendJson(res, 403, { error: "Same-origin requests required" });
            if (!req.headers["content-type"]?.startsWith("application/json")) return sendJson(res, 415, { error: "application/json required" });
          }
          try {
            const root = requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace);
            const parts = p.split("/").slice(4);
            const id = parts[0];
            if (!id && req.method === "GET") return sendJson(res, 200, { runs: listAssessments(root), checks: PENTEST_CHECKS, workspace: root,capabilities:SECURITY_CAPABILITIES });
            if (!id && req.method === "POST") {
              let input: unknown;
              try { input = await readBody(req, 250000); } catch { throw new AssessmentError("Invalid JSON request"); }
              if (!input || typeof input !== "object" || Array.isArray(input)) throw new AssessmentError("Expected an assessment object");
              return sendJson(res, 202, { run: startAssessment(root, input) });
            }
            if (id && parts.length === 1 && req.method === "GET") return sendJson(res, 200, { run: readAssessment(root, id) });
            if(id && parts.length===2 && parts[1]==="plan" && req.method==="GET") {
              const planned=readAssessment(root,id);
              if(!planned.plan)return sendJson(res,409,{error:"Plan unavailable; the assessment is still running or predates self-planning"});
              return sendJson(res,200,{plan:planned.plan});
            }
            if(id&&parts.length===2&&parts[1]==='repairs'&&req.method==='GET')return sendJson(res,200,{repairs:listRepairs(root,id)});
            if(id&&parts[1]==='repairs'&&req.method==='POST'&&(parts.length===2||(parts.length===4&&['apply','rollback'].includes(parts[3]!)))){
              const input=await readBody(req,4000);
              return sendJson(res,200,{repair:parts.length===2?prepareRepair(root,id,input):changeRepair(root,id,parts[2]!,input,parts[3]==='rollback')});
            }
            if(id&&parts.length===3&&parts[1]==="browser-evidence"&&req.method==="GET"){
              if(req.headers["sec-fetch-site"]==="cross-site")return sendJson(res,403,{error:"Same-origin evidence access required"});
              const proof=readAssessment(root,id).browser?.proofs.find(p=>p.id===parts[2]);
              if(!proof?.artifact)return sendJson(res,404,{error:"Browser artifact not found"});
              try{const data=readBrowserArtifact(root,proof);res.writeHead(200,{"content-type":"image/png","x-content-type-options":"nosniff","cache-control":"no-store"});res.end(data);return;}
              catch{return sendJson(res,409,{error:"Browser artifact unavailable or integrity mismatch"});}
            }
            if(id && parts.length===2 && ["triage","retest"].includes(parts[1]!) && req.method==="POST") {
              let input:unknown;
              try{input=await readBody(req,20000);}catch{throw new AssessmentError("Invalid JSON request");}
              if(!input||typeof input!=="object"||Array.isArray(input))throw new AssessmentError("Expected an object");
              return sendJson(res,parts[1]==="retest"?202:200,{run:parts[1]==="retest"?retestAssessment(root,id,input):updateFinding(root,id,input)});
            }
            if(id && parts.length===2 && parts[1]==="sarif" && req.method==="GET") {
              const output=sarif(readAssessment(root,id).findings);
              res.writeHead(200,{"content-type":"application/sarif+json","content-disposition":`attachment; filename="security-${id}.sarif"`});res.end(JSON.stringify(output,null,2));return;
            }
            if (id && parts.length===2 && parts[1] === "cancel" && req.method === "POST") return sendJson(res, 200, { run: cancelAssessment(root, id) });
            if (id && parts.length===2 && parts[1] === "report" && req.method === "GET") {
              const report = assessmentReport(root, id);
              res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="security-${id}.md"`, "cache-control": "no-store" });
              res.end(report); return;
            }
            return sendJson(res, 404, { error: "Unknown assessment route" });
          } catch (error) {
            if (error instanceof AssessmentError) return sendJson(res, error.status, { error: error.message });
            throw error;
          }
        }

        if (req.method === "GET" && p === "/api/pentest/checks") {
          sendJson(res, 200, { checks: PENTEST_CHECKS, workspace: requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace) });
          return;
        }

        if (req.method === "POST" && p === "/api/pentest/scan") {
          const workspace = requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace);
          const body = (await readBody(req)) as { target?: string; check?: string; writeReport?: boolean };
          const target = typeof body.target === "string" ? body.target.trim() : "";
          const check = typeof body.check === "string" && body.check.trim() ? body.check.trim() : "all";
          const findings = target ? await runPentestCheck(target, check) : [];
          const scan = scanWorkspaceRoutesAndRisks(workspace);
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

        if (req.method === "GET" && p.startsWith("/vendor/three/")) {
          const addon = p.startsWith("/vendor/three/addons/");
          const base = path.join(ROOT, "node_modules", "three", addon ? "examples/jsm" : "build");
          const relative = p.slice(addon ? "/vendor/three/addons/".length : "/vendor/three/".length);
          const file = path.resolve(base, relative);
          if (!file.startsWith(base + path.sep) || !relative.endsWith(".js") || (!addon && !["three.module.js", "three.core.js"].includes(relative)) || !fs.existsSync(file)) return sendJson(res, 404, { error: "Not found" });
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
          fs.createReadStream(file).pipe(res); return;
        }
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
          const body = (await readBody(req)) as { theme?: unknown; model?: unknown; projectId?: unknown; autoApprove?: unknown; trainingOptOut?: unknown };
          const patch: { theme?: "dark" | "light" | "system"; model?: string; projectId?: string | null; autoApprove?: boolean; trainingOptOut?: boolean } = {};
          if (body.theme === "dark" || body.theme === "light" || body.theme === "system") patch.theme = body.theme;
          if (typeof body.model === "string") patch.model = body.model;
          if (body.projectId === null || typeof body.projectId === "string") patch.projectId = body.projectId;
          if (typeof body.autoApprove === "boolean") patch.autoApprove = body.autoApprove;
          if (typeof body.trainingOptOut === "boolean") patch.trainingOptOut = body.trainingOptOut;
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
          sendJson(res, 200, { agents: listAgentsWithChatMeta() });
          return;
        }

        // ---- task workspace files (UI files tab) ----
        if (req.method === "GET" && p.startsWith("/api/tasks/") && p.endsWith("/files")) {
          const id = decodeURIComponent(p.slice("/api/tasks/".length, -"/files".length));
          const task = getTask(id);
          if (!task) return sendJson(res, 404, { error: "المهمة غير موجودة" });
          const root = requireTaskWorkspace(id, cfg.workspace);
          const rel = url.searchParams.get("path") ?? "";
          const dir = taskPath(root, rel);
          if (!dir.startsWith(path.resolve(root))) return sendJson(res, 400, { error: "مسار غير صالح" });
          let entries: Array<{ name: string; dir: boolean; bytes: number; at: string }> = [];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
              .filter((e) => e.name !== ".loam" && e.name !== "node_modules")
              .map((e) => {
                const full = path.join(dir, e.name);
                const st = fs.statSync(full);
                return { name: e.name, dir: e.isDirectory(), bytes: st.size, at: st.mtime.toISOString() };
              })
              .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
          } catch {
            return sendJson(res, 404, { error: "المجلد غير موجود" });
          }
          return sendJson(res, 200, { path: rel || ".", files: entries });
        }

        // ---- voice session transcript (13): two-party labeled turns ----
        if (p.startsWith("/api/agents/") && p.includes("/voice")) {
          const rest = decodeURIComponent(p.slice("/api/agents/".length));
          const [agentId, action] = rest.split("/");
          if (!agentId || !getAgent(agentId)) return sendJson(res, 404, { error: "الوكيل غير موجود" });
          if (req.method === "GET" && (!action || action === "voice")) return sendJson(res, 200, { turns: listVoiceTurns(agentId) });
          if (req.method === "POST" && action === "voice" && p.endsWith("/transcribe")) {
            const raw = await readRawBody(req);
            if (raw.length === 0) return sendJson(res, 400, { error: "audio bytes required" });
            const result = await transcribeAudio(raw);
            if ("error" in result) return sendJson(res, 502, result);
            return sendJson(res, 200, { segments: result });
          }
          if (req.method === "POST" && action === "voice" && !p.endsWith("/transcribe")) {
            const body = (await readBody(req)) as { speaker?: unknown; text?: unknown; end?: unknown };
            const turn = appendVoiceTurn(agentId, { speaker: typeof body.speaker === "string" ? body.speaker : "user", text: typeof body.text === "string" ? body.text : "", ...(typeof body.end === "string" ? { end: body.end } : {}) });
            if ("error" in turn) return sendJson(res, 400, turn);
            return sendJson(res, 200, { turn });
          }
          if (req.method === "DELETE" && (!action || action === "voice")) return sendJson(res, 200, { cleared: clearVoiceTranscript(agentId) });
          if (req.method === "POST" && action === "voice" && p.includes("/transcribe")) {
            const raw = await readRawBody(req);
            if (raw.length === 0) return sendJson(res, 400, { error: "audio bytes required" });
            const result = await transcribeAudio(raw);
            if ("error" in result) return sendJson(res, 502, result);
            return sendJson(res, 200, { segments: result });
          }
        }

        // ---- secrets vault (18): names only; values never travel through the model ----
        if (p.startsWith("/api/agents/") && p.includes("/secrets") && getAgent(decodeURIComponent(p.slice("/api/agents/".length).split("/")[0] ?? ""))) {
          const agentId = decodeURIComponent(p.slice("/api/agents/".length).split("/")[0] ?? "");
          if (req.method === "GET") {
            return sendJson(res, 200, { secrets: listSecrets(agentId) });
          }
          if (req.method === "POST") {
            const body = (await readBody(req)) as { name?: unknown; value?: unknown };
            if (typeof body.name !== "string" || typeof body.value !== "string") return sendJson(res, 400, { error: "name وvalue مطلوبان" });
            const result = setSecret(agentId, body.name, body.value);
            if (result !== true) return sendJson(res, 400, result);
            return sendJson(res, 200, { ok: true, note: "حُفظ السر مشفرًا — القيمة لا تظهر مجددًا لأي واجهة أو نموذج." });
          }
          if (req.method === "DELETE") {
            const name = url.searchParams.get("name") ?? "";
            return sendJson(res, 200, { deleted: deleteSecret(agentId, name) });
          }
        }

        // ---- sensitive-action approvals center (18) ----
        if (req.method === "GET" && p === "/api/approvals") {
          return sendJson(res, 200, { approvals: listApprovals(url.searchParams.get("pending") !== "0") });
        }
        if (req.method === "POST" && p.startsWith("/api/approvals/")) {
          const id = decodeURIComponent(p.slice("/api/approvals/".length));
          const body = (await readBody(req)) as { decision?: unknown };
          if (body.decision !== "approve" && body.decision !== "deny") return sendJson(res, 400, { error: "decision يجب أن يكون approve أو deny" });
          const rec = decideApproval(id, body.decision);
          if (!rec) return sendJson(res, 404, { error: "الطلب غير موجود" });
          if (rec.status === "pending") return sendJson(res, 409, { error: "بُتّ في الطلب مسبقًا" , approval: rec });
          return sendJson(res, 200, { approval: rec });
        }
        if (req.method === "GET" && p.startsWith("/api/approvals/")) {
          const rec = getApproval(decodeURIComponent(p.slice("/api/approvals/".length)));
          if (!rec) return sendJson(res, 404, { error: "الطلب غير موجود" });
          return sendJson(res, 200, { approval: rec });
        }

        // ---- per-companion usage/cost (section 19) + project handover (section 1) ----
        if (req.method === "GET" && p.startsWith("/api/agents/") && p.endsWith("/usage")) {
          const id = decodeURIComponent(p.slice("/api/agents/".length, -"/usage".length));
          if (!getAgent(id)) return sendJson(res, 404, { error: "الوكيل غير موجود" });
          const tasksByAgent = new Map(listTasks().map((t) => [t.id, t.agentId ?? null]));
          const rows = readTelemetry(2000).filter((r) => r.taskId && tasksByAgent.get(r.taskId) === id);
          const usage = {
            runs: rows.length,
            done: rows.filter((r) => r.status === "done").length,
            errors: rows.filter((r) => r.status === "error").length,
            promptTokens: rows.reduce((a, r) => a + (r.usage?.promptTokens ?? 0), 0),
            completionTokens: rows.reduce((a, r) => a + (r.usage?.completionTokens ?? 0), 0),
            toolCalls: rows.reduce((a, r) => a + (r.toolCalls?.length ?? 0), 0),
            deviceToolCalls: rows.reduce((a, r) => a + (r.toolCalls?.filter((c) => c.name?.startsWith("device_")).length ?? 0), 0),
            lastRunAt: rows[0]?.at ?? null,
          };
          sendJson(res, 200, { usage, costNote: "نماذج وأجهزة محلية على حاسوبك — لا تكلفة سحابية؛ الرموز أعلاه مقياس الاستهلاك" });
          return;
        }
        if (req.method === "POST" && p.startsWith("/api/projects/") && p.endsWith("/handover")) {
          const id = decodeURIComponent(p.slice("/api/projects/".length, -"/handover".length));
          const project = getProject(id);
          if (!project) return sendJson(res, 404, { error: "المشروع غير موجود" });
          const body = (await readBody(req)) as { toAgentId?: unknown };
          const toAgentId = typeof body.toAgentId === "string" ? body.toAgentId : "";
          const target = getAgent(toAgentId);
          if (!target) return sendJson(res, 400, { error: "الرفيق المستلم غير موجود" });
          const projectTasks = listTasks(id).filter((t) => t.agentId && t.agentId !== toAgentId);
          const previousOwners = [...new Set(projectTasks.map((t) => t.agentId!))];
          for (const t of projectTasks) setTaskAgent(t.id, toAgentId);
          // Explicit context handover: copy each previous owner's active memory into the receiver.
          let importedEntries = 0;
          // Transfer ONLY memory tied to this project's tasks (not the owner's entire personal memory)
          const projectTaskIds = new Set(projectTasks.map((t) => t.id));
          for (const owner of previousOwners) {
            const ownerEntries = listMemory(owner, { includeInactive: true });
            const projectEntries = ownerEntries.filter((e) => e.taskId && projectTaskIds.has(e.taskId));
            const dump = JSON.stringify({ entries: projectEntries });
            const res2 = importMemory(toAgentId, dump);
            if (!("error" in res2)) importedEntries += res2.imported;
          }
          sendJson(res, 200, {
            handedOver: projectTasks.length,
            fromAgents: previousOwners,
            toAgent: { id: target.id, name: target.name },
            memoryEntriesTransferred: importedEntries,
            note: "انتقلت مهام المشروع إلى الرفيق المستلم مع نسخة من ذاكرة الملاك السابقين (تظهر عنده موسومة بالمصدر).",
          });
          return;
        }

        // ---- companion personal memory (stage 4a): review/edit/supersede/export ----
        if (p.startsWith("/api/agents/") && p.includes("/memory")) {
          const rest = decodeURIComponent(p.slice("/api/agents/".length));
          const [agentId, memoryAction, entryId] = rest.split("/");
          if (!agentId || !getAgent(agentId)) return sendJson(res, 404, { error: "الوكيل غير موجود" });
          if (req.method === "GET" && (!memoryAction || memoryAction === "memory")) {
            return sendJson(res, 200, { entries: listMemory(agentId, { q: url.searchParams.get("q") ?? undefined, includeInactive: url.searchParams.get("all") === "1" }) });
          }
          if (req.method === "GET" && memoryAction === "memory" && entryId === "export") {
            const body = exportMemory(agentId);
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="loam-memory-${agentId}.json"` });
            res.end(body);
            return;
          }
          if (req.method === "POST" && memoryAction === "memory" && (!entryId || entryId === "import")) {
            if (entryId === "import") {
              const raw = await readBody(req);
              const result = importMemory(agentId, typeof raw === "string" ? raw : JSON.stringify(raw));
              if ("error" in result) return sendJson(res, 400, result);
              return sendJson(res, 200, result);
            }
            const body = (await readBody(req)) as { text?: unknown; kind?: unknown; confidence?: unknown; ttlDays?: unknown };
            const created = remember(agentId, { text: typeof body.text === "string" ? body.text : "", kind: "preference", source: "user", ...(Number.isFinite(Number(body.confidence)) ? { confidence: Number(body.confidence) } : {}), ...(Number(body.ttlDays) > 0 ? { ttlDays: Number(body.ttlDays) } : {}) });
            if ("error" in created) return sendJson(res, 400, created);
            return sendJson(res, 200, { entry: created });
          }
          if (req.method === "POST" && memoryAction === "memory" && entryId === "supersede") {
            const body = (await readBody(req)) as { entryId?: unknown; text?: unknown };
            if (typeof body.entryId !== "string" || typeof body.text !== "string" || !body.text.trim()) return sendJson(res, 400, { error: "entryId وtext مطلوبان" });
            const result = supersedeMemory(agentId, body.entryId, body.text);
            if ("error" in result) return sendJson(res, 404, result);
            return sendJson(res, 200, { result });
          }
          if ((req.method === "POST" || req.method === "PATCH") && memoryAction === "memory" && entryId) {
            const body = (await readBody(req)) as { text?: unknown; confidence?: unknown; kind?: unknown };
            const updated = editMemory(agentId, entryId, {
              ...(typeof body.text === "string" ? { text: body.text } : {}),
              ...(Number.isFinite(Number(body.confidence)) ? { confidence: Number(body.confidence) } : {}),
              ...(typeof body.kind === "string" ? { kind: body.kind } : {}),
            });
            if ("error" in updated) return sendJson(res, 404, updated);
            return sendJson(res, 200, { entry: updated });
          }
          if (req.method === "DELETE" && memoryAction === "memory" && entryId) {
            return sendJson(res, 200, { deleted: forget(agentId, entryId) });
          }
        }

        // ---- companion templates, duplicate/archive/export, agent accounts (1/17/22), health (23) ----
        if (req.method === "GET" && p === "/api/agent-templates") {
          return sendJson(res, 200, { templates: AGENT_TEMPLATES });
        }
        if (req.method === "POST" && p === "/api/agents/from-template") {
          const body = (await readBody(req)) as { templateId?: unknown; name?: unknown };
          let template;
          try { template = getAgentTemplate(typeof body.templateId === "string" ? body.templateId : ""); }
          catch (error) { return sendJson(res, 400, { error: String(error) }); }
          const agent = createAgent({
            name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : template.labelAr,
            emoji: template.emoji,
            description: template.description,
            instructions: template.instructions,
            mode: template.mode,
            workMode: template.workMode,
            ...(Array.isArray(template.allowedServices) ? { allowedServices: template.allowedServices } : {}),
          });
          return sendJson(res, 200, { agent });
        }
        if (req.method === "POST" && p.startsWith("/api/agents/") && p.endsWith("/duplicate")) {
          const id = decodeURIComponent(p.slice("/api/agents/".length, -"/duplicate".length));
          const source = getAgent(id);
          if (!source) return sendJson(res, 404, { error: "الوكيل غير موجود" });
          const agent = createAgent({
            name: source.name + " (نسخة)",
            emoji: source.emoji,
            description: source.description,
            instructions: source.instructions,
            model: source.model,
            mode: source.mode,
            effort: source.effort,
            disabledTools: source.disabledTools,
            workMode: source.workMode,
            allowedServices: source.allowedServices,
            voice: source.voice,
            ...(source.voiceRate !== undefined ? { voiceRate: source.voiceRate } : {}),
            ...(typeof source.voiceAuto === "boolean" ? { voiceAuto: source.voiceAuto } : {}),
            ...sanitizeAvatarFields(source),
          });
          return sendJson(res, 200, { agent });
        }
        if (req.method === "POST" && p.startsWith("/api/agents/") && p.endsWith("/archive")) {
          const id = decodeURIComponent(p.slice("/api/agents/".length, -"/archive".length));
          const agent = getAgent(id);
          if (!agent) return sendJson(res, 404, { error: "الوكيل غير موجود" });
          const archived = setAgentArchived(id, true);
          if (archived?.archivedAt) {
            // Stop every event source that could still trigger this companion.
            for (const s of listSchedules()) {
              if (s.agentId === id) {
                if (s.kind === "file-watch") stopWatcher(s.id);
                deleteSchedule(s.id);
              }
            }
          }
          return sendJson(res, 200, { archived: Boolean(archived?.archivedAt), agent: archived, note: "أُرشف الرفيق وأُوقفت كل روتيناته ومشغلاته — بياناته محفوظة" });
        }
        if (req.method === "POST" && p.startsWith("/api/agents/") && p.endsWith("/unarchive")) {
          const id = decodeURIComponent(p.slice("/api/agents/".length, -"/unarchive".length));
          const agent = getAgent(id);
          if (!agent) return sendJson(res, 404, { error: "الوكيل غير موجود" });
          const restored = setAgentArchived(id, false);
          return sendJson(res, 200, { archived: false, agent: restored });
        }
        // ---- hide/unhide (Loam-local [INF]): POST /hide {hidden?=true} is idempotent ----
        if (req.method === "POST" && p.startsWith("/api/agents/") && p.endsWith("/hide")) {
          const id = decodeURIComponent(p.slice("/api/agents/".length, -"/hide".length));
          const agent = getAgent(id);
          if (!agent) return sendJson(res, 404, { error: "الوكيل غير موجود" });
          let body: { hidden?: unknown } = {};
          try {
            body = (await readBody(req)) as { hidden?: unknown };
          } catch {
            body = {};
          }
          const hidden = typeof body.hidden === "boolean" ? body.hidden : true;
          const updated = setAgentHidden(id, hidden);
          return sendJson(res, 200, { hidden: Boolean(updated?.hiddenAt), agent: updated });
        }
        if (req.method === "POST" && p === "/api/agents/reorder") {
          const body = (await readBody(req)) as { ids?: unknown };
          if (!Array.isArray(body.ids) || body.ids.some((v) => typeof v !== "string")) {
            return sendJson(res, 400, { error: "ids يجب أن تكون قائمة معرفات" });
          }
          const pinned = reorderAgents(body.ids as string[]);
          return sendJson(res, 200, { pinned, agents: listAgents() });
        }
        if (req.method === "POST" && p.startsWith("/api/agents/") && p.endsWith("/pin")) {
          const id = decodeURIComponent(p.slice("/api/agents/".length, -"/pin".length));
          const agent = getAgent(id);
          if (!agent) return sendJson(res, 404, { error: "الوكيل غير موجود" });
          const body = (await readBody(req)) as { pinned?: unknown };
          const pinned = body.pinned === undefined ? true : body.pinned === true;
          const updated = setAgentPinned(id, pinned);
          if (!updated) return sendJson(res, 404, { error: "الوكيل غير موجود" });
          return sendJson(res, 200, { agent: updated });
        }
        if (req.method === "GET" && p.startsWith("/api/agents/") && p.endsWith("/export")) {
          const id = decodeURIComponent(p.slice("/api/agents/".length, -"/export".length));
          const agent = getAgent(id);
          if (!agent) return sendJson(res, 404, { error: "الوكيل غير موجود" });
          const bundle: CompanionBundle = {
            kind: "loam-companion-bundle",
            version: 1,
            exportedAt: new Date().toISOString(),
            agent: agent as unknown as Record<string, unknown>,
            memory: listMemory(id, { includeInactive: true }).map((e) => { const { embedding, ...rest } = e as unknown as { embedding?: unknown }; return rest; }) as unknown as Array<Record<string, unknown>>,
            schedules: listSchedules().filter((s) => s.agentId === id) as unknown as Array<Record<string, unknown>>,
            voiceTurns: listVoiceTurns(id) as unknown as Array<Record<string, unknown>>,
          };
          const file = writeBundleFile(bundle, agent.name);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ...bundle, bundleFile: file }, null, 1));
          return;
        }
        if (req.method === "POST" && p === "/api/agents/import") {
          const body = (await readBody(req)) as unknown;
          const bundle = sanitizeBundle(body);
          if ("error" in bundle) return sendJson(res, 400, bundle);
          const src = bundle.agent as Record<string, unknown>;
          const agent = createAgent({
            name: typeof src.name === "string" ? src.name + " (مستورد)" : "مساعد مستورد",
            ...(typeof src.emoji === "string" ? { emoji: src.emoji } : {}),
            ...(typeof src.description === "string" ? { description: src.description } : {}),
            ...(typeof src.instructions === "string" ? { instructions: src.instructions } : {}),
            ...(typeof src.model === "string" && src.model.trim() ? { model: src.model } : {}),
            ...(typeof src.mode === "string" ? { mode: src.mode } : {}),
            ...(typeof src.effort === "string" ? { effort: src.effort } : {}),
            ...(Array.isArray(src.disabledTools) ? { disabledTools: src.disabledTools } : {}),
            ...(typeof src.workMode === "string" ? { workMode: src.workMode } : {}),
            ...(Array.isArray(src.allowedServices) ? { allowedServices: src.allowedServices } : {}),
            ...(typeof src.voice === "string" ? { voice: src.voice } : {}),
            ...(Number.isFinite(Number(src.voiceRate)) ? { voiceRate: src.voiceRate as number } : {}),
            ...(typeof src.voiceAuto === "boolean" ? { voiceAuto: src.voiceAuto } : {}),
            ...(typeof src.source === "string" && src.source.trim() ? { source: src.source.trim().slice(0, 32) } : {}),
            ...sanitizeAvatarFields(src as { avatarShape?: unknown; avatarColor?: unknown; avatarImage?: unknown }),
          });
          let importedMemory = 0;
          for (const entry of bundle.memory) {
            const e = entry as Record<string, unknown>;
            const created = remember(agent.id, {
              text: String(e.text ?? ""), kind: String(e.kind ?? "fact"), source: typeof e.source === "string" ? e.source : "user", confidence: Number(e.confidence ?? 0.7),
              // Lifecycle survives the round-trip: an expired/superseded memory stays that way.
              ...(typeof e.expiresAt === "string" && e.expiresAt ? { expiresAt: e.expiresAt } : {}),
              ...(typeof e.supersededBy === "string" && e.supersededBy ? { supersededBy: e.supersededBy } : {}),
            });
            if (!("error" in created)) importedMemory += 1;
          }
          let importedSchedules = 0;
          for (const entry of bundle.schedules) {
            const e = entry as Record<string, unknown>;
            if (typeof e.prompt !== "string" || !e.prompt.trim()) continue;
            const created = addSchedule(e.prompt, Number(e.intervalSeconds ?? 3600), agent.id, typeof e.workMode === "string" ? e.workMode : undefined, e.kind === "file-watch" || e.kind === "service-watch" ? e.kind : "cron", typeof e.watchPath === "string" ? e.watchPath : undefined, e.enabled !== false);
            if (created) importedSchedules += 1;
          }
          let importedVoiceTurns = 0;
          for (const entry of bundle.voiceTurns) {
            const e = entry as Record<string, unknown>;
            // Bundles store `speaker`; older exports used `role` — accept both.
            const speakerRaw = typeof e.speaker === "string" && e.speaker ? e.speaker : e.role;
            if (typeof speakerRaw !== "string" || typeof e.text !== "string") continue;
            appendVoiceTurn(agent.id, { speaker: speakerRaw === "user" ? "user" : "assistant", text: e.text });
            importedVoiceTurns += 1;
          }
          return sendJson(res, 200, { agent, importedMemory, importedSchedules, importedVoiceTurns });
        }
        if (req.method === "POST" && p === "/api/agents/import-grokbot") {
          const body = (await readBody(req)) as { bundle?: unknown };
          const sanitized = sanitizeGrokbotBundle(body.bundle);
          if ("error" in sanitized) return sendJson(res, 400, sanitized);
          const result = importGrokbotBundle(sanitized);
          return sendJson(res, 200, result);
        }
        if (p.startsWith("/api/agents/") && p.includes("/integrations") && getAgent(decodeURIComponent(p.slice("/api/agents/".length).split("/")[0] ?? ""))) {
          const agentId = decodeURIComponent(p.slice("/api/agents/".length).split("/")[0] ?? "");
          if (req.method === "GET") return sendJson(res, 200, { granted: agentIntegrationGrants(agentId) });
          if (req.method === "POST") {
            const body = (await readBody(req)) as { names?: unknown };
            if (!Array.isArray(body.names)) return sendJson(res, 400, { error: "names مطلوبة كمصفوفة" });
            if (!registry) return sendJson(res, 503, { error: "سجل الأدوات غير متاح" });
            try { saveAgentIntegrationGrants(agentId, body.names.filter((n): n is string => typeof n === "string"), registry); }
            catch (error) { return sendJson(res, 400, { error: String(error) }); }
            return sendJson(res, 200, { granted: agentIntegrationGrants(agentId) });
          }
        }
        if (req.method === "GET" && p === "/api/health/companions") {
          const devices = listDevices().map((d) => ({ id: d.id, name: d.name, state: d.state, control: d.controlHeldBy }));
          const ollamaReachable = await fetch(cfg.ollamaUrl.replace(/\/+$/, "") + "/api/tags", { signal: AbortSignal.timeout(4000) }).then((r) => r.ok).catch(() => false);
          return sendJson(res, 200, {
            at: new Date().toISOString(),
            models: { reachable: ollamaReachable, configured: cfg.model },
            queue: executionQueue.snapshot(),
            devices,
            watchers: watchSchedules().length,
            pendingApprovals: listApprovals(true).length,
            agents: listAgents().length,
            browserSessions: getBrowserState().sessions.length,
          });
        }

        // ---- remote continuity channel (22): keyed access from the LAN (phone/web) ----
        const LOAM_REMOTE_PAGE = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loam بعيد</title><style>body{font-family:system-ui;max-width:640px;margin:0 auto;padding:1.2rem;background:#101613;color:#e8efe9}textarea,select,button{font-family:inherit;font-size:1rem}textarea{width:100%;min-height:96px;padding:.7rem;border-radius:10px;border:1px solid #2c3a30;background:#0b100d;color:#e8efe9}button{background:#4f7d5c;color:#fff;border:0;border-radius:10px;padding:.65rem 1.4rem;margin-top:.5rem}#st{margin-top:.8rem;font-size:.9rem;color:#9fb8a8;white-space:pre-wrap}</style></head><body>
<h2>🤖 Loam — من هاتفك</h2>
<p style="color:#9fb8a8;font-size:.9rem">أرسل مهمة لمساعدك على جهازك المنزلي، وتابع حالتها هنا.</p>
<select id="ag" style="width:100%;padding:.6rem;border-radius:10px;background:#0b100d;color:#e8efe9;border:1px solid #2c3a30"></select>
<textarea id="p" placeholder="اكتب المهمة…"></textarea><br>
<button onclick="send()">إرسال للمساعد</button>
<button onclick="location.reload()" style="background:#2c3a30">تحديث القائمة</button>
<div id="st"></div>
<script>
const KEY=new URLSearchParams(location.search).get('key')||'';
const H={'content-type':'application/json','x-loam-key':KEY};
async function loadAgents(){try{const r=await fetch('/api/agents',{headers:H});const d=await r.json();const s=document.getElementById('ag');s.innerHTML=(d.agents||[]).map(a=>'<option value="'+a.id+'">'+a.name+' — '+(a.description||'')+'</option>').join('');}catch(e){document.getElementById('st').textContent='تعذر تحميل المساعدين: '+e.message;}}
async function send(){const p=document.getElementById('p').value.trim();if(!p)return;const ag=document.getElementById('ag').value;const st=document.getElementById('st');st.textContent='⏳ جارٍ الإرسال…';try{const r=await fetch('/api/remote/trigger',{method:'POST',headers:H,body:JSON.stringify({prompt:p,agentId:ag||undefined})});const d=await r.json();if(!r.ok)throw new Error(d.error||r.status);st.textContent='✅ بدأت المهمة ('+d.taskId+') — أتابعها…';poll(d.taskId);}catch(e){st.textContent='✗ '+e.message;}}
async function poll(id){for(let i=0;i<120;i++){await new Promise(r=>setTimeout(r,3000));try{const r=await fetch('/api/remote/status?taskId='+encodeURIComponent(id),{headers:H});const d=await r.json();if(d.status==='done'){document.getElementById('st').textContent='🎉 اكتملت المهمة!

'+(d.notification?.body||'');return;}if(d.status==='error'||d.status==='cancelled'){document.getElementById('st').textContent='✗ انتهت: '+d.status;return;}document.getElementById('st').textContent='⏳ الحالة: '+d.status+'…';}catch(e){}}document.getElementById('st').textContent='انتهت مهلة المتابعة — المهمة ما زالت تعمل على جهازك.';}
loadAgents();
</script></body></html>`;
        const remoteKey = () => process.env.LOAM_REMOTE_KEY || "";
        const remoteOk = (req2: import("node:http").IncomingMessage): boolean => remoteKey() !== "" && req2.headers["x-loam-key"] === remoteKey();
        if (req.method === "GET" && p === "/remote") {
          if (!remoteOk(req) && url.searchParams.get("key") !== remoteKey()) {
            res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
            res.end('<!doctype html><meta charset="utf-8"><body dir="rtl" style="font-family:system-ui;padding:2rem"><h3>مفتاح الوصول مطلوب</h3><input id="k" placeholder="المفتاح" style="padding:.6rem;width:220px"><script>function go(){location=\'/remote?key=\'+encodeURIComponent(document.getElementById(\'k\').value)}</script><button onclick="go()" style="padding:.6rem">دخول</button></body>');
            return;
          }
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(LOAM_REMOTE_PAGE);
          return;
        }
        if (req.method === "POST" && p === "/api/remote/trigger") {
          if (!remoteOk(req)) return sendJson(res, 401, { error: "مفتاح الوصول غير صالح — فعّل LOAM_REMOTE_KEY على جهاز Loam" });
          const body = (await readBody(req)) as { prompt?: unknown; agentId?: unknown };
          const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
          if (!prompt) return sendJson(res, 400, { error: "prompt مطلوب" });
          const agentId = typeof body.agentId === "string" && body.agentId ? body.agentId : undefined;
          const task0 = createTask(prompt, "طلب بعيد", null, agentId);
          void runTask({ taskId: task0.id, prompt, ...(agentId ? { agentId } : {}), emit: () => {} }).catch((e) => log.warn("remote trigger: " + String(e)));
          return sendJson(res, 202, { taskId: task0.id, note: "بدأ التنفيذ — راقب /api/remote/status" });
        }
        if (req.method === "GET" && p === "/api/remote/status") {
          if (!remoteOk(req)) return sendJson(res, 401, { error: "مفتاح الوصول غير صالح" });
          const id = url.searchParams.get("taskId") ?? "";
          const task2 = getTask(id);
          if (!task2) return sendJson(res, 404, { error: "المهمة غير موجودة" });
          const last2 = (task2.messages ?? []).filter((m) => m.role === "assistant").at(-1);
          return sendJson(res, 200, { taskId: id, status: task2.status, notification: task2.status === "done" ? { title: "اكتملت المهمة البعيدة", body: (last2?.content ?? "").slice(0, 400) } : null });
        }

        // ---- companion gateway: work modes + service catalog (unified tool gateway) ----
        if (req.method === "GET" && p === "/api/work-modes") {
          sendJson(res, 200, getWorkModesUi(registry?.names() ?? []));
          return;
        }

        if (req.method === "POST" && p === "/api/agents") {
          const body = (await readBody(req)) as { name?: unknown; emoji?: unknown; description?: unknown; title?: unknown; instructions?: unknown; model?: unknown; mode?: unknown; effort?: unknown; disabledTools?: unknown; workMode?: unknown; allowedServices?: unknown; voice?: unknown; voiceRate?: unknown; voiceAuto?: unknown; notifications?: unknown; source?: unknown; avatarShape?: unknown; avatarColor?: unknown; avatarImage?: unknown };
          const name = typeof body.name === "string" ? body.name.trim() : "";
          if (!name) return sendJson(res, 400, { error: "اسم الوكيل مطلوب" });
          try {
            const agent = createAgent({
              name,
              emoji: typeof body.emoji === "string" ? body.emoji : undefined,
              description: typeof body.description === "string" ? body.description : undefined,
              title: typeof body.title === "string" ? body.title : undefined,
              instructions: typeof body.instructions === "string" ? body.instructions : undefined,
              model: typeof body.model === "string" ? body.model : undefined,
              mode: typeof body.mode === "string" ? body.mode : undefined,
              effort: typeof body.effort === "string" ? body.effort : undefined,
              disabledTools: body.disabledTools,
              workMode: typeof body.workMode === "string" && body.workMode.trim() ? body.workMode : undefined,
              allowedServices: body.allowedServices,
              ...(typeof body.voice === "string" && body.voice.trim() ? { voice: body.voice } : {}),
              ...(Number.isFinite(Number(body.voiceRate)) ? { voiceRate: Number(body.voiceRate) } : {}),
              ...(typeof body.voiceAuto === "boolean" ? { voiceAuto: body.voiceAuto } : {}),
              ...(typeof body.notifications === "boolean" ? { notifications: body.notifications } : {}),
              ...(typeof body.source === "string" && body.source.trim() ? { source: body.source.trim().slice(0, 32) } : {}),
              ...sanitizeAvatarFields(body),
            });
            sendJson(res, 200, { agent });
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        if (await handleScratchpadRoutes(req, res, p)) return;
        // Design Studio (/api/design/*): brand kits, templates, generate, outputs.
        if (await handleDesignStudioRoutes(req, res, p)) return;
        if (await handleWorkspaceVideoRoutes(req, res, p, { workspace: cfg.workspace })) return;
        // Craft apps (/api/craft/status): which vendored dists are installed.
        if (await handleCraftRoutes(req, res, p)) return;
        if (await handleInstructionsRoutes(req, res, p)) return;
        if (await handleAgentSpawnRoutes(req, res, p)) return;
        if (await handleAgentThreadRoutes(req, res, p)) return;
        if (await handleRetryLastRoutes(req, res, p)) return;
        if (await handleSchedulesRoutes(req, res, p)) return;
        if (await handleAutoVideoRoutes(req, res, p)) return;
        if (await handleLiveViewRoutes(req, res, p, { screenLive: live })) return;
        if (await handleTranscriptRoutes(req, res, p, { workspace: cfg.workspace })) return;
        // Composer mic proxy (option #19): raw recorded audio -> local STT server.
        if (await handleVoiceRoutes(req, res, p)) return;
        // Bots marketplace: must precede the /api/agents/:id prefix block so
        // /api/agents/from-catalog is matched by the exact-path handler.
        if (await handleMarketplaceRoutes(req, res, p)) return;
        if (await handlePersonalizationRoutes(req, res, p)) return;
        if (await handleApiKeysRoutes(req, res, p)) return;
        if (await handleDataControlsRoutes(req, res, p)) return;
        // Settings › Connectors (UNIMPLEMENTED_OPTIONS #3): list/connect/callback/disconnect.
        if (await handleConnectorsRoutes(req, res, p)) return;
        // Settings › Skills (UNIMPLEMENTED_OPTIONS #4): proxy the memory-skills MCP.
        if (await handleMemorySkillsRoutes(req, res, p, { call: memorySkillsCall })) return;
        if (await handleApprovalRuleRoutes(req, res, p, url)) return;
        if (await handleGrokbotBridgeRoutes(req, res, p, url)) return;
        // Public read-only task shares (option #11): create/revoke are authed,
        // GET /api/share/:token is the anonymous replay feed exempted above.
        if (await handleShareRoutes(req, res, p)) return;
        // Project context + model tiers (options 17/18/22): must precede the
        // generic /api/projects/ and /api/schedules/ handlers below.
        if (await handleProjectContextRoutes(req, res, p)) return;
        // Repo wiki (D8): list/generate/read DeepWiki-style pages.
        if (await handleWikiRoutes(req, res, p, { workspace: cfg.workspace, ollama, model: cfg.model })) return;

        // ---- avatar (Grok Bot-style): set shape/color/image on an existing agent ----
        // Must run before the generic /api/agents/:id prefix block.
        if (req.method === "POST" && p.startsWith("/api/agents/") && p.endsWith("/avatar")) {
          const id = decodeURIComponent(p.slice("/api/agents/".length, -"/avatar".length));
          const body = (await readBody(req)) as { avatarShape?: unknown; avatarColor?: unknown; avatarImage?: unknown };
          const patch: { avatarShape?: string | null; avatarColor?: string | null; avatarImage?: string | null } = {};
          for (const field of ["avatarShape", "avatarColor", "avatarImage"] as const) {
            if (body[field] === null) patch[field] = null;
            else if (typeof body[field] === "string") patch[field] = body[field] as string;
          }
          const agent = updateAgent(id, patch);
          if (!agent) return sendJson(res, 404, { error: "الوكيل غير موجود" });
          sendJson(res, 200, { agent });
          return;
        }

        if (p.startsWith("/api/agents/")) {
          const id = decodeURIComponent(p.slice("/api/agents/".length));
          if (req.method === "GET") {
            const agent = getAgent(id);
            if (!agent) return sendJson(res, 404, { error: "الوكيل غير موجود" });
            const mode = agent.mode ?? "build";
            const caps = resolveCompanionCapabilities({
              mode,
              workMode: agent.workMode ?? "loam",
              allowedServices: agent.allowedServices,
              disabledTools: agent.disabledTools,
              registeredTools: registry?.names() ?? [],
            });
            // Augment: show which of each service's tools actually reach this run
            // (after mode intersection), not just the service-level grant.
            const servicesWithTools = caps.services.map((svc) => {
              const total = svc.tools.length;
              const reachable = svc.tools.filter((t) => caps.allow.includes(t)).length;
              return { ...svc, reachableTools: reachable, totalTools: svc.totalTools, effective: reachable > 0 };
            });
            sendJson(res, 200, { agent, capabilities: { ...caps, services: servicesWithTools } });
            return;
          }
          if (req.method === "POST") {
            const body = (await readBody(req)) as { name?: unknown; emoji?: unknown; description?: unknown; title?: unknown; instructions?: unknown; model?: unknown; mode?: unknown; effort?: unknown; disabledTools?: unknown; workMode?: unknown; allowedServices?: unknown; voice?: unknown; voiceRate?: unknown; voiceAuto?: unknown; notifications?: unknown; avatarShape?: unknown; avatarColor?: unknown; avatarImage?: unknown };
            const patch: { name?: string; emoji?: string; description?: string; title?: string | null; instructions?: string; model?: string | null; mode?: string | null; effort?: string | null; disabledTools?: unknown; workMode?: string | null; allowedServices?: unknown; voice?: string | null; voiceRate?: number | null; voiceAuto?: boolean | null; notifications?: boolean | null; avatarShape?: string | null; avatarColor?: string | null; avatarImage?: string | null } = {};
            if (typeof body.name === "string") patch.name = body.name;
            if (typeof body.emoji === "string") patch.emoji = body.emoji;
            if (typeof body.description === "string") patch.description = body.description;
            if (body.title === null) patch.title = null;
            else if (typeof body.title === "string") patch.title = body.title;
            if (typeof body.instructions === "string") patch.instructions = body.instructions;
            if (body.model === null) patch.model = null;
            else if (typeof body.model === "string") patch.model = body.model;
            if (body.mode === null) patch.mode = null;
            else if (typeof body.mode === "string") patch.mode = body.mode;
            if (body.effort === null) patch.effort = null;
            else if (typeof body.effort === "string") patch.effort = body.effort;
            if (body.disabledTools !== undefined) patch.disabledTools = body.disabledTools;
            if (body.workMode === null) patch.workMode = null;
            else if (typeof body.workMode === "string" && body.workMode.trim()) patch.workMode = body.workMode;
            if (body.allowedServices !== undefined) patch.allowedServices = body.allowedServices;
            if (body.voice === null) patch.voice = null;
            else if (typeof body.voice === "string" && body.voice.trim()) patch.voice = body.voice;
            if (body.voiceRate === null) patch.voiceRate = null;
            else if (Number.isFinite(Number(body.voiceRate))) patch.voiceRate = Number(body.voiceRate);
            if (body.voiceAuto === null) patch.voiceAuto = null;
            else if (typeof body.voiceAuto === "boolean") patch.voiceAuto = body.voiceAuto;
            if (body.notifications !== undefined) patch.notifications = typeof body.notifications === "boolean" ? body.notifications : null;
            for (const field of ["avatarShape", "avatarColor", "avatarImage"] as const) {
              if (body[field] === null) patch[field] = null;
              else if (typeof body[field] === "string") patch[field] = body[field] as string;
            }
            let agent: ReturnType<typeof updateAgent>;
            try {
              agent = updateAgent(id, patch);
            } catch (err) {
              return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
            }
            if (!agent) return sendJson(res, 404, { error: "الوكيل غير موجود" });
            sendJson(res, 200, { agent });
            return;
          }
          if (req.method === "DELETE") {
            sendJson(res, 200, { deleted: deleteAgent(id) });
            return;
          }
        }

        // ---- companion devices (frontier stage 2): lifecycle + viewer APIs ----
        if (req.method === "GET" && p === "/api/companion-devices") {
          sendJson(res, 200, {
            devices: listDevices(),
            templates: DEVICE_TEMPLATES.map((t) => ({ id: t.id, labelAr: t.labelAr, description: t.description, environment: t.environment })),
            goldenReady: deviceManager.goldenReady(),
            ...(await deviceManager.providers()),
          });
          return;
        }
        if (req.method === "POST" && p === "/api/companion-devices/golden") {
          const body = (await readBody(req)) as { fromDistro?: unknown };
          const fromDistro = typeof body.fromDistro === "string" && body.fromDistro.trim() ? body.fromDistro.trim() : undefined;
          if (!fromDistro) return sendJson(res, 400, { error: "fromDistro مطلوب (اسم توزيعة WSL تُصدَّر كصورة أساس)" });
          try {
            sendJson(res, fromDistro ? 200 : 400, await deviceManager.prepareGolden(fromDistro));
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }
        if (req.method === "POST" && p === "/api/companion-devices") {
          const body = (await readBody(req)) as { agentId?: unknown; template?: unknown; name?: unknown; resources?: unknown };
          const agentId = typeof body.agentId === "string" ? body.agentId : "";
          if (!agentId || !getAgent(agentId)) return sendJson(res, 400, { error: "agentId غير صالح — اختر المساعد أولًا" });
          let created: Awaited<ReturnType<typeof deviceManager.create>>;
          try {
            created = await deviceManager.create({
              agentId,
              template: typeof body.template === "string" ? body.template : "coding",
              ...(typeof body.name === "string" && body.name.trim() ? { name: body.name } : {}),
              ...(body.resources && typeof body.resources === "object" ? { resources: body.resources as Record<string, number> } : {}),
            });
          } catch (err) {
            return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          if ("error" in created) return sendJson(res, 409, created);
          sendJson(res, 202, { device: created });
          return;
        }
        if (p.startsWith("/api/companion-devices/")) {
          const rest = decodeURIComponent(p.slice("/api/companion-devices/".length));
          const [id, action] = rest.split("/");
          if (!id) return sendJson(res, 404, { error: "الجهاز غير موجود" });
          const device = getDevice(id);
          if (req.method === "GET" && !action) {
            if (!device) return sendJson(res, 404, { error: "الجهاز غير موجود" });
            sendJson(res, 200, { device, journal: readJournal(device), readiness: await deviceManager.isReady(id) });
            return;
          }
          if (req.method === "GET" && action === "stats") {
            if (!device) return sendJson(res, 404, { error: "الجهاز غير موجود" });
            const stats = await deviceManager.stats(id);
            if ("error" in stats) return sendJson(res, 409, stats);
            sendJson(res, 200, { stats, costNote: "جهاز محلي على حاسوبك — لا تكلفة سحابية" });
            return;
          }
          if (req.method === "GET" && action === "files") {
            if (!device) return sendJson(res, 404, { error: "الجهاز غير موجود" });
            const listing = await deviceManager.listFiles(id, url.searchParams.get("path") ?? "/home/loam");
            if (typeof listing === "string") return sendJson(res, 200, { listing });
            return sendJson(res, 409, listing);
          }
          if (req.method === "GET" && action === "file") {
            if (!device) return sendJson(res, 404, { error: "الجهاز غير موجود" });
            const pathInDevice = url.searchParams.get("path") ?? "";
            if (!pathInDevice) return sendJson(res, 400, { error: "path مطلوب" });
            const buf = await deviceManager.readFile(id, pathInDevice);
            if ("error" in buf) return sendJson(res, 409, buf);
            res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${encodeURIComponent(path.posix.basename(pathInDevice))}"` });
            res.end(buf);
            return;
          }
          if (req.method === "POST" && action === "file") {
            if (!device) return sendJson(res, 404, { error: "الجهاز غير موجود" });
            const raw = await readRawBody(req);
            if (raw.length === 0) return sendJson(res, 400, { error: "empty upload" });
            const name = path.basename(url.searchParams.get("path") ?? `upload-${Date.now()}`);
            const safe = name.replace(/[^\w.\u0600-\u06ff -]+/g, "_").slice(0, 120) || "upload.bin";
            const written = await deviceManager.writeFile(id, `/home/loam/inbox/${safe}`, raw);
            if (written !== true) return sendJson(res, 409, written);
            sendJson(res, 200, { ok: true, path: `/home/loam/inbox/${safe}`, bytes: raw.length });
            return;
          }
          // ---- live GUI viewer: boot the X session, stream frames, manual input ----
          if (req.method === "POST" && action === "gui-ensure") {
            if (!device) return sendJson(res, 404, { error: "الجهاز غير موجود" });
            const result = await deviceManager.ensureGui(id);
            if ("error" in result) return sendJson(res, 409, result);
            return sendJson(res, 200, result);
          }
          if (req.method === "GET" && action === "windows") {
            if (!device) return sendJson(res, 404, { error: "الجهاز غير موجود" });
            const windows = await deviceManager.guiWindows(id);
            if ("error" in windows) return sendJson(res, 409, windows);
            return sendJson(res, 200, { windows });
          }
          if (req.method === "GET" && (action === "screen" || action === "stream")) {
            if (!device) return sendJson(res, 404, { error: "الجهاز غير موجود" });
            const ensure = url.searchParams.get("ensure") !== "0";
            if (action === "screen") {
              const frame = await deviceManager.captureScreen(id, ensure);
              if ("error" in frame) return sendJson(res, 409, frame);
              res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
              res.end(frame);
              return;
            }
            // MJPEG live stream: frames until the client disconnects or the cap hits.
            res.writeHead(200, {
              "content-type": "multipart/x-mixed-replace; boundary=loamframe",
              "cache-control": "no-cache, no-transform",
              connection: "keep-alive",
            });
            let closed = false;
            res.on("close", () => { closed = true; });
            const intervalMs = Math.max(250, Math.min(5000, Number(url.searchParams.get("intervalMs") ?? 1000)));
            const maxFrames = Math.min(1800, Math.max(1, Number(url.searchParams.get("frames") ?? 1800)));
            let sent = 0;
            while (!closed && sent < maxFrames) {
              const frame = await deviceManager.captureScreen(id, ensure);
              if (Buffer.isBuffer(frame)) {
                res.write(`--loamframe\r\ncontent-type: image/jpeg\r\ncontent-length: ${frame.length}\r\n\r\n`);
                res.write(frame);
                res.write("\r\n");
                sent += 1;
              } else if (sent === 0 && "error" in frame) {
                // Surface a first-frame failure inside the stream, then stop.
                res.write(`--loamframe\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(frame.error)}\r\n\r\n${frame.error}\r\n`);
                break;
              }
              await new Promise((r) => setTimeout(r, intervalMs));
            }
            res.end();
            return;
          }
          if (req.method === "POST" && action === "input") {
            if (!device) return sendJson(res, 404, { error: "الجهاز غير موجود" });
            const body = (await readBody(req)) as { type?: unknown; x?: unknown; y?: unknown; text?: unknown; key?: unknown };
            const allowed = ["click", "doubleclick", "rightclick", "move", "type", "key", "scroll"];
            if (typeof body.type !== "string" || !allowed.includes(body.type)) return sendJson(res, 400, { error: `type يجب أن يكون أحد: ${allowed.join(", ")}` });
            const result = await deviceManager.sendGuiInput(id, {
              type: body.type as "click",
              ...(typeof body.x === "number" ? { x: body.x } : {}),
              ...(typeof body.y === "number" ? { y: body.y } : {}),
              ...(typeof body.text === "string" ? { text: body.text } : {}),
              ...(typeof body.key === "string" ? { key: body.key } : {}),
            });
            if (result !== true) return sendJson(res, 409, result);
            sendJson(res, 200, { ok: true });
            return;
          }
          if (req.method === "POST" && ["start", "stop", "suspend", "resume"].includes(action ?? "")) {
            if (!device) return sendJson(res, 404, { error: "الجهاز غير موجود" });
            const op = deviceManager[action as "start" | "stop" | "suspend" | "resume"].bind(deviceManager);
            const result = await op(id);
            if ("error" in result) return sendJson(res, 409, result);
            sendJson(res, 200, { device: result });
            return;
          }
          if (req.method === "POST" && (action === "snapshot" || action === "restore" || action === "control" || action === "exec")) {
            if (!device) return sendJson(res, 404, { error: "الجهاز غير موجود" });
            const body = (await readBody(req)) as { label?: unknown; snapshotId?: unknown; take?: unknown; command?: unknown };
            if (action === "snapshot") {
              const result = await deviceManager.snapshot(id, typeof body.label === "string" ? body.label : "");
              if ("error" in result) return sendJson(res, 409, result);
              return sendJson(res, 200, { device: result });
            }
            if (action === "restore") {
              if (typeof body.snapshotId !== "string") return sendJson(res, 400, { error: "snapshotId مطلوب" });
              const result = await deviceManager.restore(id, body.snapshotId);
              if ("error" in result) return sendJson(res, 409, result);
              return sendJson(res, 200, { device: result });
            }
            if (action === "control") {
              const result = deviceManager.setControl(id, body.take === true ? "user" : "agent");
              if ("error" in result) return sendJson(res, 404, result);
              return sendJson(res, 200, { device: result });
            }
            // exec: the viewer's manual console — requires the user to hold control.
            if (typeof body.command !== "string" || !body.command.trim()) return sendJson(res, 400, { error: "command مطلوب" });
            const result = await deviceManager.userExec(device, body.command);
            if ("error" in result) return sendJson(res, 409, result);
            return sendJson(res, 200, { result });
          }
          if (req.method === "DELETE") {
            const result = await deviceManager.remove(id, url.searchParams.get("confirm") === "true");
            if ("error" in result) return sendJson(res, url.searchParams.get("confirm") === "true" ? 409 : 428, result);
            sendJson(res, 200, result);
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
          sendJson(res, 200, executionQueue.snapshot().active === taskId ? getBrowserState() : { running: false, recording: false, pages: [], actions: [], lastTable: null, lastVideoPath: null, lastTracePath: null, traceName: null, traceStartedAt: null, sessions: getBrowserState().sessions });
          return;
        }

        if (req.method === "GET" && p === "/api/media") {
          const rel = url.searchParams.get("path") ?? "";
          // Sane default instead of HTTP 400: a taskId without a path lists the
          // task's streamable media files, newest first, so gallery consumers get
          // a usable list mode from the same endpoint they stream from.
          const MEDIA_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".mp4", ".webm", ".mov", ".mkv", ".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac"]);
          if (!rel) {
            try {
              const root = requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace);
              const max = Math.min(Math.max(Number(url.searchParams.get("max") ?? 200), 1), 2000);
              const entries: Array<{ name: string; path: string; size: number; mtime: string; mtimeMs: number }> = [];
              const scanCap = Math.max(max * 6, 2500);
              const walk = (d: string, depth: number): void => {
                if (entries.length >= scanCap || depth > 5) return;
                let items: fs.Dirent[] = [];
                try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
                for (const it of items) {
                  if (entries.length >= scanCap) return;
                  if (it.isSymbolicLink()) continue;
                  const full = path.join(d, it.name);
                  try {
                    const st = fs.statSync(full);
                    if (!MEDIA_EXTS.has(path.extname(it.name).toLowerCase())) continue;
                    entries.push({ name: it.name, path: path.relative(root, full).split(path.sep).join("/"), size: st.size, mtime: st.mtime.toISOString(), mtimeMs: st.mtimeMs });
                  } catch { /* ignore */ }
                  if (it.isDirectory()) walk(full, depth + 1);
                }
              };
              walk(root, 0);
              entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
              const trimmed = entries.slice(0, max).map(({ mtimeMs: _m, ...rest }) => rest);
              sendJson(res, 200, { entries: trimmed });
            } catch (err) {
              sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
            }
            return;
          }
          try {
            const file = taskPath(requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace), rel);
            if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(res, 404, { error: "not found" });
            const st = fs.statSync(file);
            let start = 0, end = st.size - 1;
            const range = req.headers.range;
            if (range) {
              const match = /^bytes=(\d*)-(\d*)$/.exec(range);
              if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }).end(); return; }
              if (!match[1]) start = Math.max(0, st.size - Number(match[2]));
              else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
              if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }).end(); return; }
            }
            res.writeHead(range ? 206 : 200, {
              "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
              "content-length": range ? end - start + 1 : st.size,
              "accept-ranges": "bytes",
              ...(range ? { 'content-range': `bytes ${start}-${end}/${st.size}` } : {}),
              "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:",
              "x-content-type-options": "nosniff",
              "cache-control": "no-store",
            });
            const stream = fs.createReadStream(file, range ? { start, end } : undefined);
            stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        if (req.method === "GET" && p === "/api/files") {
          const rel = (url.searchParams.get("path") ?? "").trim().replace(/^[/\\]+/, "");
          const max = Math.min(Math.max(Number(url.searchParams.get("max") ?? 300), 1), 2000);
          const taskIdParam = url.searchParams.get("taskId");
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
          type FileEntry = { name: string; path: string; dir: boolean; size: number; mtime: string; mtimeMs: number; taskId?: string };
          const scanWorkspace = (root: string, ownerTaskId: string | undefined, entries: FileEntry[], budget: number): void => {
            let dir: string;
            try { dir = taskPath(root, rel); } catch { return; }
            if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
            const walk = (d: string, depth: number): void => {
              if (entries.length >= budget || depth > 5) return;
              let items: fs.Dirent[] = [];
              try {
                items = fs.readdirSync(d, { withFileTypes: true });
              } catch {
                return;
              }
              for (const it of items) {
                if (entries.length >= budget) return;
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
                    ...(ownerTaskId ? { taskId: ownerTaskId } : {}),
                  });
                } catch {
                  /* ignore */
                }
                if (it.isDirectory()) walk(full, depth + 1);
              }
            };
            walk(dir, 0);
          };
          // Sane default for the Creations and Library pages: with `list=1` and no
          // taskId the endpoint lists every task's files at once, newest first, with
          // each entry tagged with taskId so media links stay per-task. Without the
          // flag the strict per-task contract (taskId required) is unchanged.
          if (!taskIdParam && url.searchParams.get("list") === "1") {
            const entries: FileEntry[] = [];
            for (const task of listTasks().slice(0, 200)) {
              if (!task.workspace) continue;
              try { scanWorkspace(task.workspace, task.id, entries, max); } catch { /* skip unreadable task */ }
            }
            entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
            const trimmed = entries.slice(0, max).map(({ mtimeMs: _m, ...rest }) => rest);
            sendJson(res, 200, { path: rel, entries: trimmed });
            return;
          }
          const root = requireTaskWorkspace(taskIdParam, cfg.workspace);
          const dir = taskPath(root, rel);
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return sendJson(res, 404, { error: "directory not found" });
          const entries: FileEntry[] = [];
          scanWorkspace(root, undefined, entries, Math.max(max * 6, 2500));
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

        if ((p === "/api/creative" && ["GET", "POST"].includes(req.method ?? "")) || (p === "/api/creative/asset" && req.method === "POST")) {
          try {
            const body = p === "/api/creative" && req.method === "POST" ? await readBody(req, 2_100_000) as { taskId?: unknown; scene?: unknown; expectedRevision?: unknown } : null;
            const taskId = body?.taskId ?? url.searchParams.get("taskId");
            // Sane default for the Creations page: with `list=1` and no taskId the
            // endpoint lists every saved creative scene across media tasks so the
            // gallery can load in one call. The strict per-task contract (taskId
            // required, media mode enforced) is unchanged otherwise.
            if (!taskId && req.method === "GET" && url.searchParams.get("list") === "1") {
              const scenes: Array<{ taskId: string; title: string; revision: number; updatedAt: string }> = [];
              for (const task of listTasks().slice(0, 200)) {
                if (!task.workspace) continue;
                try {
                  if (getLoamMode(task.mode).id !== "media") continue;
                  const scene = readScene(task.workspace);
                  if (!scene) continue;
                  let updatedAt = "";
                  try { updatedAt = fs.statSync(taskPath(task.workspace, ".loam/creative.json")).mtime.toISOString(); } catch { /* */ }
                  scenes.push({ taskId: task.id, title: scene.title, revision: scene.revision, updatedAt });
                } catch { /* skip unreadable scene */ }
              }
              scenes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
              return sendJson(res, 200, { scenes });
            }
            const root = requireTaskWorkspace(taskId, cfg.workspace);
            if (getLoamMode(getTask(String(taskId))!.mode).id !== "media") return sendJson(res, 403, { error: "Creative studio requires a media task" });
            if (p === "/api/creative/asset") {
              const buffer = await readRawBody(req, MAX_GLB_BYTES);
              validateGlb(buffer);
              const asset = `assets/creative/${randomUUID()}.glb`;
              const file = taskPath(root, asset);
              fs.mkdirSync(path.dirname(file), { recursive: true });
              fs.writeFileSync(file, buffer, { flag: "wx" });
              return sendJson(res, 201, { path: asset, bytes: buffer.length });
            }
            return sendJson(res, 200, { scene: body ? saveScene(root, body.scene, body.expectedRevision) : readScene(root) });
          } catch (error) {
            if (error instanceof CreativeError) return sendJson(res, error.status, { error: error.message, ...(error.status === 409 ? { scene: error.scene } : {}) });
            throw error;
          }
        }
        if (p === "/api/studio/import" && req.method === "POST") {
          try {
            const root = requireTaskWorkspace(url.searchParams.get("taskId"), cfg.workspace);
            const task = getTask(String(url.searchParams.get("taskId")))!;
            if (!["write", "data"].includes(getLoamMode(task.mode).id)) return sendJson(res, 403, { error: "Studio is available only in Loam Write and Loam Data" });
            const revision = url.searchParams.get("expectedRevision");
            if (revision === null || !/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw new StudioError("expectedRevision is required");
            const buffer = await new Promise<Buffer>((resolve, reject) => {
              const chunks: Buffer[] = []; let size = 0, finished = false;
              req.on("data", (chunk: Buffer) => {
                if (finished) return;
                size += chunk.length;
                if (size > 20 * 1024 * 1024) { finished = true; chunks.length = 0; reject(new StudioError("Maximum import size is 20 MB", 413)); return; }
                chunks.push(chunk);
              });
              req.on("end", () => { if (!finished) resolve(Buffer.concat(chunks)); });
              req.on("error", reject);
              req.on("aborted", () => reject(new StudioError("Import upload interrupted")));
            });
            const artifact = await importStudio(root, buffer, url.searchParams.get("name") ?? "", Number(revision));
            return sendJson(res, 200, { artifact });
          } catch (error) {
            if (error instanceof StudioError) return sendJson(res, error.status, { error: error.message, ...(error.status === 409 ? { artifact: error.artifact } : {}) });
            throw error;
          }
        }
        if ((p === "/api/studio" && ["GET", "POST"].includes(req.method ?? "")) || (["/api/studio/export", "/api/studio/preview", "/api/studio/slide-preview"].includes(p) && req.method === "GET")) {
          try {
            const body = req.method === "POST" ? await readBody(req, 2_100_000) as { taskId?: unknown; artifact?: unknown; expectedRevision?: unknown; validateExport?: boolean } : null;
            const taskId = body?.taskId ?? url.searchParams.get("taskId");
            const root = requireTaskWorkspace(taskId, cfg.workspace);
            const task = getTask(String(taskId))!;
            if (!["write", "data"].includes(getLoamMode(task.mode).id)) return sendJson(res, 403, { error: "Studio is available only in Loam Write and Loam Data" });
            if (body) {
              if(body.validateExport === true){const checked=validateStudio(body.artifact);await exportStudio({...checked,revision:Number(body.expectedRevision)} as StudioArtifact,root);}
              return sendJson(res, 200, { artifact: saveStudio(root, body.artifact, body.expectedRevision) });
            }
            const artifact = readStudio(root);
            if(p==='/api/studio/slide-preview'){
              if(!artifact||artifact.kind!=='presentation')return sendJson(res,404,{error:'No presentation to preview'});
              if(url.searchParams.get('revision')!==String(artifact.revision))return sendJson(res,409,{error:'Preview revision changed'});
              const index=Number(url.searchParams.get('slide'));
              if(!Number.isInteger(index)||index<0||index>=artifact.content.slides.length)return sendJson(res,400,{error:'Invalid slide index'});
              const output=await exportStudio(artifact,root),png=await renderSlidePreview(output.buffer,index+1);
              res.writeHead(200,{'content-type':'image/png','cache-control':'no-store','x-loam-revision':String(artifact.revision)});res.end(png);return;
            }
            if (p === '/api/studio/preview') {
              if (!artifact || artifact.kind !== 'document') return sendJson(res, 404, { error: 'No Word document to preview' });
              const output = await exportStudio(artifact, root);
              const pdf = await renderWordPreview(url.searchParams.get('interactive') === '1' ? await interactiveWordCopy(output.buffer, artifact) : output.buffer);
              res.writeHead(200, { 'content-type': 'application/pdf', 'cache-control': 'no-store', 'x-loam-preview-engine': 'microsoft-word', 'x-loam-revision': String(artifact.revision) });
              res.end(pdf); return;
            }
            if (p === "/api/studio/export") {
              if (!artifact) return sendJson(res, 404, { error: "No studio artifact to export" });
              const output = await exportStudio(artifact, root);
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

        // Loam Video Studio relay: the panel attached to this task posts the
        // result of a command that was dispatched over the task's event stream.
        if (req.method === "POST" && /^\/api\/tasks\/[^/]+\/video-studio\/result$/.test(p)) {
          const origin = req.headers.origin;
          if ((origin && origin !== `http://${req.headers.host}`) || req.headers["sec-fetch-site"] === "cross-site") {
            return sendJson(res, 403, { error: "same-origin requests required" });
          }
          const taskId = decodeURIComponent(p.slice("/api/tasks/".length, -"/video-studio/result".length));
          if (!getTask(taskId)) return sendJson(res, 404, { error: "task not found" });
          let raw: unknown;
          try { raw = await readBody(req, 64_000); } catch { return sendJson(res, 400, { error: "invalid JSON body" }); }
          const result = raw as VideoStudioResult;
          if (!result || typeof result !== "object" || typeof result.id !== "string" || typeof result.taskId !== "string") {
            return sendJson(res, 400, { error: "id and taskId are required" });
          }
          if (result.taskId !== taskId) return sendJson(res, 400, { error: "taskId mismatch" });
          const handled = videoStudioRelay.resolve(result);
          return sendJson(res, 200, { ok: handled, ...(handled ? {} : { ignored: true }) });
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
          const body = (await readBody(req)) as { prompt?: unknown; intervalSeconds?: unknown; agentId?: unknown; workMode?: unknown; enabled?: unknown; cron?: unknown; at?: unknown; runAt?: unknown; timezone?: unknown };
          const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
          const intervalSeconds = Number(body.intervalSeconds ?? 0);
          const agentId = typeof body.agentId === "string" && body.agentId ? body.agentId : undefined;
          const workMode = body.workMode === "own_device" || body.workMode === "loam" ? body.workMode : undefined;
          const cron = typeof body.cron === "string" && body.cron.trim() ? body.cron.trim() : undefined;
          const runAt = typeof body.at === "string" && body.at.trim() ? body.at.trim() : typeof body.runAt === "string" && body.runAt.trim() ? body.runAt.trim() : undefined;
          const timezone = typeof body.timezone === "string" && body.timezone.trim() ? body.timezone.trim() : undefined;
          if (!prompt) return sendJson(res, 400, { error: "prompt required" });
          if (cron && runAt) return sendJson(res, 400, { error: "cron and at are mutually exclusive" });
          if (timezone && !isValidTimezone(timezone)) return sendJson(res, 400, { error: `منطقة زمنية غير معروفة: ${timezone}` });
          if (runAt && Number.isNaN(Date.parse(runAt))) return sendJson(res, 400, { error: "at must be an ISO timestamp" });
          if (!cron && !runAt && (!Number.isFinite(intervalSeconds) || intervalSeconds < 30)) return sendJson(res, 400, { error: "intervalSeconds must be >= 30" });
          if (agentId && !getAgent(agentId)) return sendJson(res, 400, { error: "الوكيل غير موجود" });
          try {
            const schedule = addSchedule(prompt, Number.isFinite(intervalSeconds) ? intervalSeconds : 0, agentId, workMode, cron || runAt ? "cron" : undefined, undefined, body.enabled !== false, { cron, runAt, timezone });
            sendJson(res, 200, { schedule });
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        // Run a routine immediately as its companion (manual trigger for the continuous mode).
        // ---- event-driven routines (16): file-watch triggers + idle/resource scan (3-4/23) ----
        if (req.method === "POST" && p === "/api/schedules/watch") {
          const body = (await readBody(req)) as { prompt?: unknown; watchPath?: unknown; agentId?: unknown; workMode?: unknown };
          const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
          const watchPath = typeof body.watchPath === "string" ? body.watchPath.trim() : "";
          if (!prompt || !watchPath) return sendJson(res, 400, { error: "prompt وwatchPath مطلوبان" });
          const agentId = typeof body.agentId === "string" && body.agentId ? body.agentId : undefined;
          if (agentId && !getAgent(agentId)) return sendJson(res, 400, { error: "الوكيل غير موجود" });
          const workMode = body.workMode === "own_device" || body.workMode === "loam" ? body.workMode : undefined;
          const run = (globalThis as unknown as { __loamScheduledRun?: (o: { prompt: string; scheduleId: string; agentId?: string; workMode?: string }) => Promise<string> }).__loamScheduledRun;
          if (!run) return sendJson(res, 503, { error: "محرك المشغلات غير مهيأ" });
          const created = createWatchRoutine({ prompt, watchPath, agentId, workMode, run });
          if ("error" in created) return sendJson(res, 400, created);
          return sendJson(res, 201, created);
        }
        if (req.method === "POST" && p === "/api/schedules/service-watch") {
          const body = (await readBody(req)) as { prompt?: unknown; agentId?: unknown };
          const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
          if (!prompt) return sendJson(res, 400, { error: "prompt مطلوب" });
          const agentId = typeof body.agentId === "string" && body.agentId ? body.agentId : undefined;
          if (agentId && !getAgent(agentId)) return sendJson(res, 400, { error: "الوكيل غير موجود" });
          const s = addSchedule(prompt, 3600, agentId, undefined, "service-watch");
          return sendJson(res, 201, { schedule: s, note: "يُشغّل تلقائيًا عند تعطل مزود النماذج (انتقال من يعمل إلى متوقف)" });
        }
        if (req.method === "GET" && p === "/api/schedules/watch") {
          return sendJson(res, 200, { watchers: watchSchedules() });
        }
        if (req.method === "POST" && p === "/api/companion-devices/idle-scan") {
          const result = await deviceManager.scanAndSuspendIdle(url.searchParams.get("idleMinutes") ? Number(url.searchParams.get("idleMinutes")) : undefined);
          return sendJson(res, 200, result);
        }
        if (req.method === "POST" && p.startsWith("/api/schedules/") && p.endsWith("/run-now")) {
          const id = decodeURIComponent(p.slice("/api/schedules/".length, -"/run-now".length));
          const schedule = listSchedules().find((s) => s.id === id);
          if (!schedule) return sendJson(res, 404, { error: "الروتين غير موجود" });
          const previous = schedule.lastTaskId ? getTask(schedule.lastTaskId) : undefined;
          if (previous && ["queued", "running", "interrupted"].includes(previous.status)) {
            return sendJson(res, 409, { error: "تشغيل سابق لهذا الروتين ما يزال جاريًا" });
          }
          void runTask({
            prompt: schedule.prompt,
            scheduleId: schedule.id,
            ...(schedule.agentId ? { agentId: schedule.agentId } : {}),
            ...(schedule.workMode ? { workMode: schedule.workMode } : {}),
            emit: () => {},
          }).catch((error) => log.warn(`run-now ${schedule.id}: ${String(error)}`));
          sendJson(res, 202, { started: true, scheduleId: schedule.id, agentId: schedule.agentId ?? null, workMode: schedule.workMode ?? null });
          return;
        }

        if (req.method === "DELETE" && p.startsWith("/api/schedules/")) {
          const id = decodeURIComponent(p.slice("/api/schedules/".length));
          stopWatcher(id);
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
            workMode?: unknown;
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
          let workMode: string | undefined;
          try {
            workMode = typeof body.workMode === "string" && body.workMode.trim() ? normalizeWorkMode(body.workMode) : undefined;
          } catch (error) {
            return sendJson(res, 400, { error: String(error) });
          }

          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
          });

          const stopHeartbeat = startSseHeartbeat(res);
          const emit = (event: AgentEvent): void => {
            if (!res.destroyed && !res.writableEnded) res.write(`data: ${redact(JSON.stringify(event))}\n\n`);
          };

          const chosenModel = model && model.trim().length > 0 ? model : cfg.model;
          if (String(chosenModel).endsWith(":cloud") && (!cfg.cloudModel?.apiKey || cfg.cloudModel.apiKey.trim().length === 0) && !(await cloudSuffixedModelServedByOllama(String(chosenModel)))) {
            emit({ type: "error", message: "No cloud API key configured. Add cloudModel.apiKey to config.json to use cloud models." });
            stopHeartbeat();
            if (!res.destroyed && !res.writableEnded) res.end();
            return;
          }

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
              workMode,
            });
            if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify({ type: "task", taskId: result.taskId })}\n\n`);
          } catch (err) {
            if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) })}\n\n`);
          } finally {
            stopHeartbeat();
            if (!res.destroyed && !res.writableEnded) res.end();
          }
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
    server.once("close", () => { swarm?.close(); void timeline.close(); });
    server.listen(cfg.server.port, cfg.server.host, () => { const address = server.address(); if (address && typeof address !== "string") timeline.start(`http://127.0.0.1:${address.port}`); resolve(server); });
  });
}
