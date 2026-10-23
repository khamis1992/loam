/**
 * H8/H9 — Learned-lesson REST surface.
 * Reference: .h2-ref/BUILD_SPEC.md section 8. This module is the REST adapter
 * over the H2 experience store; it holds no learning logic of its own.
 *
 * Contract (BUILD_SPEC section 8):
 *   GET    /api/learning/lessons?agentId=&domain=   -> 200 { data: Lesson[] }   (vector fields stripped)
 *   PATCH  /api/learning/lessons/:id { disabled }  -> 200 { data: Lesson } | 404
 *   DELETE /api/learning/lessons/:id               -> 204 | 404
 *   GET    /api/learning/corrections?taskId=       -> 200 { data: CorrectionEvent[] }
 *
 * Adaptations forced by the real store (src/learning/harness/experienceStore.ts):
 *  - `listLessons` never returns the disabled rows unless `includeDisabled` is
 *    passed, so the PATCH route reads them back that way.
 *  - `listCorrections` is exported by the store (spec assumed it existed); the
 *    filter shape is `{ taskId, domain }`.
 *  - the vector is a base64 string plus its `dim`, both stripped from every
 *    response (section 8: "vector fields stripped").
 */
import http from "node:http";
import {
  deleteLesson,
  listCorrections,
  listLessons,
  setLessonDisabled,
} from "../../learning/harness/experienceStore.js";
import type { Lesson } from "../../learning/harness/types.js";

export interface LearningRouteContext {
  /** Optional caller scope. `null`/undefined means "any agent" (store semantics). */
  agentId?: string | null;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** End the response with no body at all (the 204 case). */
function sendEmpty(res: http.ServerResponse, status: number): void {
  res.writeHead(status, { "content-length": 0 });
  res.end();
}

async function readJson(req: http.IncomingMessage, maxBytes = 32_000): Promise<unknown> {
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

/** Strip the embedding payload; the API never ships vectors to the browser. */
function lessonJson(l: Lesson): Record<string, unknown> {
  const { dim: _dim, vector: _vector, ...rest } = l;
  void _dim;
  void _vector;
  return rest;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Learned-lesson routes. Dispatched before the generic /api/learning handler. */
export async function handleLearningRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx?: LearningRouteContext,
): Promise<boolean> {
  if (!p.startsWith("/api/learning")) return false;

  // Accept either a bare pathname or a full target: the query never selects a
  // route, and stripping it keeps callers from having to pre-split it.
  p = p.split("?")[0]!;

  const url = new URL(req.url ?? p, "http://127.0.0.1");
  const lessonMatch = /^\/api\/learning\/lessons(?:\/([^\/]+))?$/.exec(p);
  const correctionsMatch = /^\/api\/learning\/corrections$/.exec(p);
  if (!lessonMatch && !correctionsMatch) return false;

  const method = req.method ?? "GET";

  if (correctionsMatch) {
    if (method !== "GET") return false;
    const taskId = str(url.searchParams.get("taskId"));
    const domain = str(url.searchParams.get("domain"));
    sendJson(res, 200, { data: listCorrections({ taskId, domain }) });
    return true;
  }

  const lessonId = lessonMatch?.[1] !== undefined ? decodeURIComponent(lessonMatch[1]) : undefined;

  if (lessonId === undefined) {
    // GET /api/learning/lessons?agentId=&domain=
    if (method !== "GET") return false;
    const agentIdParam = url.searchParams.get("agentId");
    const domain = str(url.searchParams.get("domain"));
    const lessons = listLessons({
      // An explicit agentId wins; otherwise the route context scopes the caller.
      agentId: str(agentIdParam) ?? ctx?.agentId,
      domain,
      includeDisabled: true,
    });
    sendJson(res, 200, { data: lessons.map(lessonJson) });
    return true;
  }

  if (method === "PATCH") {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
    const disabled = (body as { disabled?: unknown } | null)?.disabled;
    if (typeof disabled !== "boolean") {
      sendJson(res, 400, { error: "disabled must be a boolean" });
      return true;
    }
    const updated = setLessonDisabled(lessonId, disabled);
    if (!updated) {
      sendJson(res, 404, { error: `no lesson ${lessonId}` });
      return true;
    }
    sendJson(res, 200, { data: lessonJson(updated) });
    return true;
  }

  if (method === "DELETE") {
    const removed = deleteLesson(lessonId);
    if (!removed) {
      sendJson(res, 404, { error: `no lesson ${lessonId}` });
      return true;
    }
    sendEmpty(res, 204);
    return true;
  }

  return false;
}
