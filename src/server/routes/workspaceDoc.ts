/** Workspace document editor routes: GET html + metadata, PUT edited html (saves .docx).
 *  Mount next to the other /api handlers (supervisor adds these two lines in http.ts):
 *    import { handleWorkspaceDocRoutes } from "./routes/workspaceDoc.js";
 *    if (await handleWorkspaceDocRoutes(req, res, p, { workspace: cfg.workspace })) return;
 */
import http from "node:http";
import { docFileMeta, loadWorkspaceDoc, saveWorkspaceDoc, DocFileError } from "../workspace/docIO.js";
import { loadDocTrack, saveDocTrack, TRACK_SIDECAR_MAX_BYTES } from "../workspace/docTrackIO.js";
import { requireTaskWorkspace } from "../taskWorkspace.js";
import { getSettings } from "../settings.js";
import { renderWordPreview } from "../../studio/word-preview.js";
import { readOfficeFileBytes } from "../../studio/office-pdf.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: http.IncomingMessage, maxBytes = 12_000_000): Promise<string> {
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
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function resolveWorkspace(ctx: { workspace?: string } | undefined): string {
  if (typeof ctx?.workspace === "string" && ctx.workspace) return ctx.workspace;
  const loaded = getSettings().workspace;
  if (!loaded) throw new DocFileError("Active workspace is not configured", 409);
  return loaded;
}

export interface WorkspaceDocRouteContext {
  workspace?: string;
}

export async function handleWorkspaceDocRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx?: WorkspaceDocRouteContext,
): Promise<boolean> {
  if (p === "/api/workspace/doc/pdf" && req.method === "GET") {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    try {
      const taskId = url.searchParams.get("taskId") ?? "";
      const rel = (url.searchParams.get("path") ?? "").trim();
      if (!taskId) throw new DocFileError("taskId required");
      if (!rel) throw new DocFileError("path required");
      const workspace = requireTaskWorkspace(taskId, resolveWorkspace(ctx));
      // The Word preview engine already returns PDF bytes for a docx buffer.
      const docx = await readOfficeFileBytes(workspace, rel, [".docx"]);
      const pdf = await renderWordPreview(docx);
      res.writeHead(200, { "content-type": "application/pdf", "cache-control": "no-store" });
      res.end(pdf);
      return true;
    } catch (error) {
      if (error instanceof DocFileError) { sendJson(res, error.status, { error: error.message }); return true; }
      const status = typeof (error as { status?: number })?.status === "number" ? (error as { status: number }).status : (/task not found/.test(String(error)) ? 404 : 500);
      sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }

  const trackMatch = /^\/api\/workspace\/doc\/track$/.exec(p);
  if (trackMatch) {
    // Track-changes sidecar: GET → { track: TrackedDocument | null }, PUT { track }.
    // Loam-side JSON persistence only (see docTrackIO) — never Word-native w:ins/w:del.
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const taskId = url.searchParams.get("taskId") ?? "";
    const rel = (url.searchParams.get("path") ?? "").trim();
    try {
      if (!taskId) throw new DocFileError("taskId required");
      if (!rel) throw new DocFileError("path required");
      const workspace = requireTaskWorkspace(taskId, resolveWorkspace(ctx));
      if (req.method === "GET") {
        sendJson(res, 200, { track: loadDocTrack(workspace, rel) });
        return true;
      }
      if (req.method === "PUT") {
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req, TRACK_SIDECAR_MAX_BYTES));
        } catch {
          throw new DocFileError("track payload required");
        }
        const track = (body as { track?: unknown } | null)?.track;
        saveDocTrack(workspace, rel, track);
        sendJson(res, 200, { ok: true });
        return true;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    } catch (error) {
      if (error instanceof DocFileError) { sendJson(res, error.status, { error: error.message }); return true; }
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, /task not found/.test(message) ? 404 : 400, { error: message });
      return true;
    }
  }

  const match = /^\/api\/workspace\/doc\/file$/.exec(p);
  if (!match) return false;
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const taskId = url.searchParams.get("taskId") ?? "";
  const rel = (url.searchParams.get("path") ?? "").trim();

  try {
    if (!taskId) throw new DocFileError("taskId required");
    if (!rel) throw new DocFileError("path required");
    const workspace = requireTaskWorkspace(taskId, resolveWorkspace(ctx));

    if (req.method === "GET") {
      if (url.searchParams.get("metaOnly") === "1") {
        const meta = docFileMeta(workspace, rel);
        sendJson(res, 200, { mtimeMs: meta.mtimeMs, size: meta.size, name: meta.name });
        return true;
      }
      const doc = await loadWorkspaceDoc(workspace, rel);
      sendJson(res, 200, doc);
      return true;
    }

    if (req.method === "PUT") {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        throw new DocFileError("html required");
      }
      const html = (body as { html?: unknown } | null)?.html;
      if (typeof html !== "string") throw new DocFileError("html required");
      const result = await saveWorkspaceDoc(workspace, rel, html);
      sendJson(res, 200, result);
      return true;
    }

    sendJson(res, 405, { error: "method not allowed" });
    return true;
  } catch (error) {
    if (error instanceof DocFileError) {
      sendJson(res, error.status, { error: error.message });
      return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, /task not found/.test(message) ? 404 : 400, { error: message });
    return true;
  }
}
