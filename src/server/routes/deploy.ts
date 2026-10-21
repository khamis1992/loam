import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { loadConfig } from "../../config.js";
import { deployTargetCatalog, type DeployToolDeps } from "../../tools/deploy.js";
import { deployBuild, exportBuild, findTarget } from "../../preview/deploy.js";

export interface DeployRouteContext extends DeployToolDeps {
  /** Optional preview service: the local target then returns a live http:// URL. */
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 16_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
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

function targetShape(target: { id: string; label: string; kind: string; requiredEnv: readonly string[] }) {
  return {
    id: target.id,
    label: target.label,
    kind: target.kind,
    requiredEnv: [...target.requiredEnv],
    configured: !target.requiredEnv.some((name) => !process.env[name]),
  };
}

/**
 * Deploy/export routes for built apps:
 *   GET  /api/deploy/targets        → target catalog + credential status
 *   POST /api/tasks/:id/deploy      → deploy the task's build output {target?}
 *   GET  /api/tasks/:id/export      → download the build output as ZIP
 * Dispatched before generic /api/tasks handlers.
 */
export async function handleDeployRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx: DeployRouteContext = {},
): Promise<boolean> {
  if (req.method === "GET" && p === "/api/deploy/targets") {
    const targets = deployTargetCatalog(resolvedDeps(ctx));
    sendJson(res, 200, { targets: targets.map(targetShape) });
    return true;
  }

  const deployMatch = /^\/api\/tasks\/([\w-]+)\/deploy$/.exec(p);
  if (req.method === "POST" && deployMatch) {
    const taskId = decodeURIComponent(deployMatch[1]!);
    let body: unknown = {};
    try {
      body = await readJson(req);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
    const wanted = (body as { target?: unknown }).target;
    const targetId = typeof wanted === "string" && wanted.trim() ? wanted.trim() : "local";
    const targets = deployTargetCatalog(resolvedDeps(ctx));
    const target = findTarget(targets, targetId);
    if (!target) {
      sendJson(res, 400, { error: "unknown target", available: targets.map(targetShape) });
      return true;
    }
    try {
      const workspace = resolvedWorkspace(ctx);
      const outcome = await deployBuild(workspace, taskId, target);
      const zip = exportBuild(workspace, taskId);
      const result = outcome.result;
      sendJson(res, result.ok ? 200 : 409, {
        ok: result.ok,
        target: result.target,
        url: result.url,
        distDir: result.distDir ?? null,
        buildDir: result.buildDir,
        zipPath: zip.zipPath,
        exportBytes: zip.bytes,
        files: result.files ?? zip.fileCount,
        missingEnv: result.missingEnv ?? [],
        message: result.message,
      });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  const exportMatch = /^\/api\/tasks\/([\w-]+)\/export$/.exec(p);
  if (req.method === "GET" && exportMatch) {
    const taskId = decodeURIComponent(exportMatch[1]!);
    try {
      const info = exportBuild(resolvedWorkspace(ctx), taskId);
      const file = fs.readFileSync(info.zipPath);
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-length": file.length,
        "content-disposition": `attachment; filename="${path.basename(info.zipPath)}"`,
      });
      res.end(file);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  return false;
}

function resolvedWorkspace(ctx: DeployRouteContext): string {
  return ctx.workspace ?? loadConfig().workspace;
}

function resolvedDeps(ctx: DeployRouteContext): DeployRouteContext {
  return { workspace: resolvedWorkspace(ctx), ...(ctx.preview ? { preview: ctx.preview } : {}) };
}
