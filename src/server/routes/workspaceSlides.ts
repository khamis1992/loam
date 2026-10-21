import http from "node:http";
import { getTask } from "../db.js";
import { loadConfig } from "../../config.js";
import { requireTaskWorkspace } from "../taskWorkspace.js";
import { StudioError } from "../../studio/store.js";
import { exportStudio } from "../../studio/export.js";
import { renderSlidePreview } from "../../studio/slide-preview.js";
import {
  readWorkspaceSlides,
  readWorkspaceSlidesRaw,
  saveWorkspaceSlides,
  duplicateWorkspaceSlide,
} from "../workspace/slidesIO.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 2_200_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new StudioError("Request body exceeds 2 MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>); }
      catch (err) { reject(new StudioError(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`)); }
    });
    req.on("error", reject);
  });
}

function requireTask(url: URL, body?: Record<string, unknown>): string {
  const raw = (url.searchParams.get("taskId") ?? body?.taskId) as unknown;
  const taskId = typeof raw === "string" ? raw : "";
  if (!taskId || !getTask(taskId)) throw new StudioError("task not found", 404);
  return taskId;
}

/** Presentation workspace editor routes. Exposes raw pptx bytes plus structured
 * slides JSON so the workspace editor can load, edit and save task files.
 * Storage sits inside the task workspace, so local-token auth and taskPath
 * containment checks apply exactly as elsewhere. */
export async function handleWorkspaceSlidesRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (!p.startsWith("/api/workspace/slides/")) return false;
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  try {
    if (p === "/api/workspace/slides/file" && req.method === "GET") {
      requireTask(url);
      const root = requireTaskWorkspace(url.searchParams.get("taskId"), loadConfig().workspace);
      const rel = url.searchParams.get("path") ?? "";
      if (url.searchParams.get("raw") === "1") {
        const bytes = readWorkspaceSlidesRaw(root, rel);
        res.writeHead(200, {
          "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "cache-control": "no-store",
        });
        res.end(bytes);
        return true;
      }
      sendJson(res, 200, await readWorkspaceSlides(root, rel));
      return true;
    }
    if (p === "/api/workspace/slides/file" && req.method === "PUT") {
      const body = await readJson(req) as { taskId?: unknown; path?: unknown; artifact?: unknown; expectedRevision?: unknown };
      requireTask(url, body);
      const root = requireTaskWorkspace(String(body.taskId ?? url.searchParams.get("taskId")), loadConfig().workspace);
      const result = await saveWorkspaceSlides(root, String(body.path ?? ""), body.artifact, body.expectedRevision);
      sendJson(res, 200, { saved: true, revision: result.artifact.revision, bytes: result.bytes });
      return true;
    }
    if (p === "/api/workspace/slides/duplicate" && req.method === "POST") {
      const body = await readJson(req) as { taskId?: unknown; path?: unknown; index?: unknown; artifact?: unknown; expectedRevision?: unknown };
      requireTask(url, body);
      const root = requireTaskWorkspace(String(body.taskId ?? url.searchParams.get("taskId")), loadConfig().workspace);
      const result = await duplicateWorkspaceSlide(
        root,
        String(body.path ?? ""),
        body.index,
        body.artifact !== undefined ? { artifact: body.artifact, expectedRevision: body.expectedRevision } : undefined,
      );
      sendJson(res, 200, { artifact: result.artifact });
      return true;
    }
    if (p === "/api/workspace/slides/preview" && req.method === "GET") {
      requireTask(url);
      const root = requireTaskWorkspace(url.searchParams.get("taskId"), loadConfig().workspace);
      const rel = url.searchParams.get("path") ?? "";
      const { artifact } = await readWorkspaceSlides(root, rel);
      if (artifact.kind !== "presentation") throw new StudioError("Expected a presentation artifact");
      const revision = url.searchParams.get("revision");
      if (revision !== null && revision !== String(artifact.revision)) throw new StudioError("Preview revision changed", 409);
      const index = Number(url.searchParams.get("slide"));
      if (!Number.isInteger(index) || index < 0 || index >= artifact.content.slides.length) throw new StudioError("Invalid slide index");
      const output = await exportStudio(artifact, root);
      const png = await renderSlidePreview(output.buffer, index + 1);
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(png);
      return true;
    }
  } catch (error) {
    if (error instanceof StudioError) {
      sendJson(res, error.status, { error: error.message, ...(error.status === 409 && error.artifact ? { artifact: error.artifact } : {}) });
      return true;
    }
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
  return false;
}
