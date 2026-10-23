/**
 * Neo N3: the Knowledge Garden HTTP surface.
 *
 * Mounted next to the other /api handlers:
 *   import { handleKnowledgeRoutes } from "./routes/knowledge.js";
 *   if (await handleKnowledgeRoutes(req, res, p, { workspace: cfg.workspace, embedder, model: cfg.memory.model })) return;
 *
 * The garden is read and written through the same module the agent tools use
 * (`src/knowledge`), so the UI and the model can never disagree about what is
 * stored. Every route is JSON and stateless apart from the garden itself.
 *
 *  - GET    /api/knowledge                  list bases (summaries) + enabled flag
 *  - POST   /api/knowledge                  create a base
 *  - PUT    /api/knowledge/:baseId          rename / re-describe a base
 *  - DELETE /api/knowledge/:baseId          delete a base and every seed in it
 *  - GET    /api/knowledge/:baseId          one base: metadata + every seed
 *  - POST   /api/knowledge/:baseId/ingest   import text / file / url into a base
 *  - POST   /api/knowledge/:baseId/seeds    add one seed by hand
 *  - PUT    /api/knowledge/:baseId/seeds/:seedId   retag a seed
 *  - DELETE /api/knowledge/:baseId/seeds/:seedId   delete a seed
 *  - GET    /api/knowledge/search            hybrid search (query, baseId, k)
 */
import http from "node:http";
import {
  createBase,
  deleteBase,
  deleteSeed,
  getBase,
  listBases,
  retagSeed,
  updateBase,
  upsertSeed,
} from "../../knowledge/store.js";
import { ingestContent, type IngestDeps } from "../../knowledge/ingest.js";
import { fromFile, fromText, fromUrl, resolveImportPath, type OcrProvider } from "../../knowledge/importers.js";
import { searchKnowledge } from "../../knowledge/search.js";
import type { KnowledgeBase, KnowledgeSeed } from "../../knowledge/types.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** Serialize a seed without the embedding blob (the vector is server-internal). */
function seedJson(seed: KnowledgeSeed): Record<string, unknown> {
  return {
    id: seed.id,
    title: seed.title,
    body: seed.body,
    tags: seed.tags,
    createdAt: seed.createdAt,
    updatedAt: seed.updatedAt,
    ...(seed.provenance ? { provenance: seed.provenance } : {}),
    ...(seed.smartSplit !== undefined ? { smartSplit: seed.smartSplit } : {}),
  };
}

function baseJson(base: KnowledgeBase): Record<string, unknown> {
  return {
    id: base.id,
    name: base.name,
    ...(base.description ? { description: base.description } : {}),
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
    seeds: base.seeds.length,
  };
}

/** True when a store error is the caller's fault (bad name / missing row). */
function isUserError(message: string): boolean {
  return /required|not found|already exists|no knowledge/.test(message);
}

export interface KnowledgeRouteContext {
  /** Root the file importer resolves relative paths against. */
  workspace?: string;
  /** Vector channel; omitted => lexical-only search and un-vectored seeds. */
  embedder?: { embed(texts: string[]): Promise<number[][]> };
  /** Model recorded on embeddings. */
  model?: string;
  /** OCR provider for image imports; omitted => images are reported, skipped. */
  ocr?: OcrProvider;
  /** Ingest dependency overrides (tests). */
  ingestDeps?: Partial<IngestDeps>;
}

const MAX_K = 50;

export async function handleKnowledgeRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx?: KnowledgeRouteContext,
): Promise<boolean> {
  if (!p.startsWith("/api/knowledge")) return false;
  // Accept either a bare pathname or a full target: the query never selects a
  // route, and stripping it keeps callers from having to pre-split it.
  p = p.split("?")[0]!;
  const workspace = ctx?.workspace;

  try {
    // ---- search (exact path, no id) ----
    if (p === "/api/knowledge/search") {
      if (req.method !== "GET") return false;
      const url = new URL(req.url ?? "/", "http://localhost");
      const query = url.searchParams.get("query") ?? "";
      const k = Math.min(Math.max(Number(url.searchParams.get("k") ?? 8) || 8, 1), MAX_K);
      const baseId = url.searchParams.get("baseId")?.trim() || undefined;
      const result = await searchKnowledge(query, {
        ...(ctx?.embedder ? { embedder: ctx.embedder } : {}),
        ...(ctx?.model ? { model: ctx.model } : {}),
        baseId,
        k,
      });
      sendJson(res, 200, {
        query: result.query,
        mode: result.mode,
        empty: result.empty,
        hits: result.hits.map((h) => ({
          seedId: h.seedId,
          baseId: h.baseId,
          title: h.title,
          preview: h.body.slice(0, 320),
          tags: h.tags,
          score: h.score,
          lexical: h.lexical,
          vector: h.vector,
          matched: h.matched,
        })),
      });
      return true;
    }

    // ---- list bases ----
    if (p === "/api/knowledge" && req.method === "GET") {
      sendJson(res, 200, { bases: listBases(), enabled: Boolean(ctx?.embedder) });
      return true;
    }

    // ---- create base ----
    if (p === "/api/knowledge" && req.method === "POST") {
      const body = (await readJson(req)) as { name?: unknown; description?: unknown };
      const name = str(body.name);
      if (!name) {
        sendJson(res, 400, { error: "name is required" });
        return true;
      }
      const base = createBase(name, str(body.description) || undefined);
      sendJson(res, 201, { base: baseJson(base) });
      return true;
    }

    // ---- one base (or its seeds) ----
    const baseMatch = /^\/api\/knowledge\/([^/]+)(?:\/(ingest|seeds))?(?:\/([^/]+))?$/.exec(p);
    if (!baseMatch) return false;
    const baseId = decodeURIComponent(baseMatch[1]!);
    const sub = baseMatch[2] ?? null;
    const subId = baseMatch[3] ? decodeURIComponent(baseMatch[3]) : null;

    if (!sub && req.method === "PUT") {
      const body = (await readJson(req)) as { name?: unknown; description?: unknown };
      const base = updateBase(baseId, {
        ...(body.name !== undefined ? { name: str(body.name) } : {}),
        ...(body.description !== undefined ? { description: str(body.description) } : {}),
      });
      sendJson(res, 200, { base: baseJson(base) });
      return true;
    }

    if (!sub && req.method === "DELETE") {
      const deleted = deleteBase(baseId);
      if (!deleted) {
        sendJson(res, 404, { error: `no knowledge base ${baseId}` });
        return true;
      }
      sendJson(res, 200, { ok: true, baseId });
      return true;
    }

    if (!sub && req.method === "GET") {
      const base = getBase(baseId);
      if (!base) {
        sendJson(res, 404, { error: `no knowledge base ${baseId}` });
        return true;
      }
      sendJson(res, 200, { base: baseJson(base), seeds: base.seeds.map(seedJson) });
      return true;
    }

    if (sub === "ingest" && req.method === "POST") {
      const body = (await readJson(req)) as {
        text?: unknown; path?: unknown; url?: unknown; baseName?: unknown; tags?: unknown; mode?: unknown;
      };
      const tags = strs(body.tags);
      const text = str(body.text).trim();
      const relPath = str(body.path).trim();
      const url = str(body.url).trim();
      const sources = [text.length > 0, relPath.length > 0, url.length > 0].filter(Boolean).length;
      if (sources === 0) {
        sendJson(res, 400, { error: "text, path or url is required" });
        return true;
      }
      if (sources > 1) {
        sendJson(res, 400, { error: "provide exactly one of text, path or url" });
        return true;
      }
      if (relPath && !workspace) {
        sendJson(res, 409, { error: "workspace is not configured" });
        return true;
      }

      let extracted: { text: string; warnings: string[] };
      let ref: string;
      if (text) {
        extracted = fromText(text);
        ref = "inline";
      } else if (relPath) {
        extracted = await fromFile(resolveImportPath(workspace!, relPath), ctx?.ocr);
        ref = relPath;
      } else {
        extracted = await fromUrl(url);
        ref = url;
      }
      if (!extracted.text) {
        // Nothing extractable is a reportable outcome, not a crash: the caller
        // gets the importer's own warnings (unsupported type, OCR skipped, ...).
        sendJson(res, 422, { ok: false, warnings: extracted.warnings });
        return true;
      }

      const result = await ingestContent(
        extracted.text,
        {
          baseId,
          ...(str(body.baseName) ? { baseName: str(body.baseName) } : {}),
          tags,
          split: str(body.mode) === "fixed" ? "fixed" : "llm",
          provenance: { source: text ? "user_text" : relPath ? "file" : "url", ref },
        },
        {
          ...(ctx?.embedder ? { embedder: ctx.embedder } : {}),
          ...(ctx?.model ? { model: ctx.model } : {}),
          ...(ctx?.ingestDeps ?? {}),
        },
      );
      sendJson(res, result.seeds.length > 0 ? 201 : 422, {
        ok: result.seeds.length > 0,
        baseId: result.baseId,
        baseName: result.baseName,
        smartSplit: result.smartSplit,
        seeds: result.seeds.map(seedJson),
        warnings: [...extracted.warnings, ...result.warnings],
      });
      return true;
    }

    if (sub === "seeds" && !subId && req.method === "POST") {
      const body = (await readJson(req)) as { title?: unknown; body?: unknown; tags?: unknown };
      const content = str(body.body).trim();
      if (!content) {
        sendJson(res, 400, { error: "body is required" });
        return true;
      }
      const base = getBase(baseId);
      if (!base) {
        sendJson(res, 404, { error: `no knowledge base ${baseId}` });
        return true;
      }
      const seed = upsertSeed(base.id, {
        id: "",
        title: str(body.title).trim() || "Untitled",
        body: content,
        tags: strs(body.tags),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      sendJson(res, 201, { seed: seedJson(seed) });
      return true;
    }

    if (sub === "seeds" && subId && req.method === "PUT") {
      const body = (await readJson(req)) as { tags?: unknown };
      const seed = retagSeed(baseId, subId, strs(body.tags));
      sendJson(res, 200, { seed: seedJson(seed) });
      return true;
    }

    if (sub === "seeds" && subId && req.method === "DELETE") {
      const deleted = deleteSeed(baseId, subId);
      if (!deleted) {
        sendJson(res, 404, { error: `no seed ${subId} in base ${baseId}` });
        return true;
      }
      sendJson(res, 200, { ok: true, seedId: subId });
      return true;
    }

    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, isUserError(message) ? 400 : 500, { error: message });
    return true;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

function readJson(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
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
