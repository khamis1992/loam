/**
 * C7 HTTP surface: /api/workflows (BUILD_SPEC §4.0.5). Same guards as the
 * other orchestration routes: no-store, same-origin + JSON on writes, 80 KB
 * body limit, validation errors as a 400 with the full `errors` list.
 */
import http from "node:http";
import type { Config } from "../../config.js";
import type { OllamaClient } from "../../ollama.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { createTask } from "../db.js";
import { createOrchestrationCore } from "../../orchestration/core.js";
import { advanceWorkflow, startWorkflow } from "../../orchestration/workflows/engine.js";
import { validateWorkflow } from "../../orchestration/workflows/validate.js";
import { deleteWorkflow, listWorkflows, loadRun, loadWorkflow, saveWorkflow } from "../../orchestration/workflows/store.js";
import { loamWorkflowPorts } from "../../orchestration/workflows/loamPorts.js";
import { seedWorkflowTemplates } from "../../orchestration/workflows/templates.js";
import { isCloudModel } from "../../llm/cloudModel.js";
import type { WorkflowDef } from "../../orchestration/workflows/types.js";

export interface WorkflowRouteDeps {
  cfg: Config;
  ollama: OllamaClient;
  tools: ToolRegistry | null;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, max = 80_000): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error("body_too_large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export async function handleWorkflowRoutes(req: http.IncomingMessage, res: http.ServerResponse, p: string, deps: WorkflowRouteDeps): Promise<boolean> {
  if (p !== "/api/workflows" && !p.startsWith("/api/workflows/")) return false;
  const reply = (status: number, body: unknown): true => {
    sendJson(res, status, body);
    return true;
  };
  res.setHeader("cache-control", "no-store");
  const crossOrigin = (origin: string | undefined) => (!!origin && origin !== `http://${req.headers.host}`) || req.headers["sec-fetch-site"] === "cross-site";
  try {
    if (p === "/api/workflows") {
      if (req.method === "GET") {
        seedWorkflowTemplates();
        return reply(200, { workflows: listWorkflows() });
      }
      return reply(405, { error: "Method not allowed" });
    }
    const m = /^\/api\/workflows\/([a-z][a-z0-9-]{1,63})(?:\/(run|runs))?\/?$/.exec(p);
    if (!m) return reply(404, { error: "Workflow endpoint not found" });
    const id = m[1]!;
    if (req.method === "GET" && m[2] === "runs") {
      // Run state is read by runId, not workflow id; the collection is not listed here.
      return reply(404, { error: "Use /api/workflows/runs/:runId for run state" });
    }
    if (req.method === "GET") {
      const def = loadWorkflow(id);
      return def ? reply(200, { workflow: def }) : reply(404, { error: "Workflow not found" });
    }
    if (crossOrigin(req.headers.origin)) return reply(403, { error: "طلبات التشغيل مسموحة من التطبيق فقط" });
    if (!req.headers["content-type"]?.startsWith("application/json")) return reply(415, { error: "application/json required" });
    if (req.method === "PUT") {
      let body: unknown;
      try {
        body = await readJson(req);
      } catch {
        return reply(400, { error: "Invalid JSON request" });
      }
      const def = body as WorkflowDef;
      if (!def || def.id !== id) return reply(400, { errors: ["body id must match the URL"] });
      const oc = deps.cfg.orchestration;
      const errors = validateWorkflow(def, { maxNodes: oc?.workflows.maxNodes ?? 64, isCloudModel: (m2) => isCloudModel(deps.cfg, m2) });
      if (errors.length > 0) return reply(400, { errors });
      saveWorkflow(def, "user");
      return reply(200, { ok: true });
    }
    if (req.method === "DELETE") {
      return reply(200, { ok: deleteWorkflow(id) });
    }
    if (req.method === "POST" && m[2] === "run") {
      const def = loadWorkflow(id);
      if (!def) return reply(404, { error: "Workflow not found" });
      if (!deps.tools) return reply(503, { error: "مسارات العمل غير متاحة في هذه الجلسة" });
      if ((deps.cfg.orchestration?.workflows.enabled ?? false) !== true) return reply(409, { error: "Workflows are turned off (orchestration.workflows.enabled = false)" });
      let body: unknown;
      try {
        body = await readJson(req);
      } catch {
        return reply(400, { error: "Invalid JSON request" });
      }
      const inputs = (body && typeof body === "object" && !Array.isArray(body) ? (body as { inputs?: Record<string, unknown> }).inputs : undefined) ?? {};
      const task = createTask(def.title, `مسار عمل: ${def.id}`);
      const run = startWorkflow(def, task.id, inputs);
      // The run executes in the background; its checkpoint after every superstep
      // (and its waiting interrupt) is durable, so a restart resumes it.
      const core = createOrchestrationCore(deps.cfg, deps.ollama, task.id, task.id);
      void advanceWorkflow(def, run, loamWorkflowPorts(core, {
        cfg: deps.cfg,
        ollama: deps.ollama,
        tools: deps.tools,
        emit: () => undefined,
        prompt: def.title,
      }), {
        maxSupersteps: core.cfg.workflows.maxSupersteps,
        maxParallelNodes: core.cfg.workflows.maxParallelNodes,
        maxSubworkflowDepth: 3,
      }).catch(() => undefined).finally(() => core.runSpan.end());
      return reply(202, { runId: run.runId, taskId: task.id });
    }
    return reply(405, { error: "Method not allowed" });
  } catch (err) {
    return reply(500, { error: err instanceof Error ? err.message : String(err) });
  }
}

/** GET /api/workflows/runs/:runId — the durable checkpoint of one run. */
export async function handleWorkflowRunRoutes(req: http.IncomingMessage, res: http.ServerResponse, p: string): Promise<boolean> {
  if (!p.startsWith("/api/workflows/runs/")) return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return true;
  }
  res.setHeader("cache-control", "no-store");
  const runId = p.slice("/api/workflows/runs/".length);
  const run = loadRun(runId);
  sendJson(res, run ? 200 : 404, run ? { run } : { error: "Run not found" });
  return true;
}
