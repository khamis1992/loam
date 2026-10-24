/**
 * Neo N13: the node-level HTTP surface for the canvas.
 *
 * The graph route (`routes/graph.ts`) reads and edits the graph as a whole. This
 * module adds what a *single node* needs once it has been produced:
 *
 *   - version history of a document/webpage node, plus the line diff between two
 *     of its versions (G18);
 *   - "Add to Knowledge Base": turn the node's text into N3 seeds with honest
 *     provenance (`source: "node"`), and preview how it will be split;
 *   - webpage-node actions (G19): resolve the page's directory, open it in the
 *     sandbox preview tab, and download a ZIP that opens offline.
 *
 * Everything is keyed by `(runId, nodeId)`, so a node is never reachable through
 * another run's URL, and every path is resolved against the task workspace with
 * `resolveArtifactDir`, which refuses to leave it. Mounted inside `startServer`,
 * so the install-token rule covers these routes like every other `/api` path.
 *
 * Routes:
 *   GET    /api/graph/:runId/nodes/:nodeId/versions
 *   GET    /api/graph/:runId/nodes/:nodeId/diff?from=A&to=B
 *   POST   /api/graph/:runId/nodes/:nodeId/versions      capture the current text
 *   GET    /api/graph/:runId/nodes/:nodeId/knowledge/preview
 *   POST   /api/graph/:runId/nodes/:nodeId/knowledge     ingest into a base
 *   GET    /api/graph/:runId/nodes/:nodeId/artifact      resolve the directory
 *   GET    /api/graph/:runId/nodes/:nodeId/artifact.zip  download the ZIP
 *   GET    /api/graph/:runId/nodes/:nodeId/preview        start the sandbox preview
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  getRunNode,
} from "../../agent/runGraphAdapter.js";
import { diffLines, type DiffResult } from "../../graph/versions.js";
import {
  captureNodeFiles,
  captureNodeVersion,
  listFileVersions,
  listVersionsForNode,
  nodeCurrentText,
  nodeFiles,
  nodeTitle,
} from "../../graph/nodeVersions.js";
import { buildArtifactZip, capturedFileEntries, resolveArtifactDir } from "../../graph/artifacts.js";
import { requireTaskWorkspace, taskPath } from "../taskWorkspace.js";
import type { PreviewService } from "../../preview/serve.js";
import { ingestNode, previewNodeSeeds } from "../../knowledge/fromNode.js";
import type { IngestDeps } from "../../knowledge/ingest.js";
import type { RunNode } from "../../graph/store.js";

/** A node payload is capped well below a file upload (same rule as the canvas). */
const MAX_BODY_BYTES = 200_000;

/** A ZIP this large is a real site; anything above is almost certainly a mistake. */
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): true {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
  // Always `true`: a reply was written, so `startServer` must stop routing.
  return true;
}

/** Read and parse a JSON body, rejecting anything above `maxBytes`. */
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
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
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on("error", reject);
  });
}

/** A cross-site mutation attempt is refused before anything is touched. */
function isCrossSite(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return Boolean(origin && origin !== `http://${req.headers.host}`) || req.headers["sec-fetch-site"] === "cross-site";
}

/** True when a store error is the caller's fault rather than a server fault. */
function isUserError(message: string): boolean {
  return /required|not found|outside workspace|body too large|invalid JSON body|no artifact/.test(message);
}

export interface NodeRouteContext {
  /** Root the node's artifact paths resolve against. */
  workspace?: string;
  /** Sandbox preview server; omitted => the preview route reports 503. */
  preview?: PreviewService;
  /** Vector channel for "Add to Knowledge Base"; omitted => lexical-only seeds. */
  embedder?: { embed(texts: string[]): Promise<number[][]> };
  /** Model recorded on the embeddings. */
  model?: string;
  /** Split override (tests). */
  ingestDeps?: Partial<IngestDeps>;
}

/** The one version pair a diff request may name; `to` defaults to the newest. */
function resolvePair(versions: readonly { version: number }[], rawFrom: unknown, rawTo: unknown): { from: number; to: number } | undefined {
  const max = versions.reduce((m, v) => Math.max(m, v.version), 0);
  const min = versions.reduce((m, v) => Math.min(m, v.version), Number.POSITIVE_INFINITY);
  const from = Number(rawFrom);
  const to = rawTo === null || rawTo === undefined || rawTo === "" ? max : Number(rawTo);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  const floor = Number.isFinite(min) ? min : 1;
  if (from < floor || from > max || to < floor || to > max) return undefined;
  return { from: Math.floor(from), to: Math.floor(to) };
}

/** The node + its task workspace, or a status the route should reply with. */
type NodeLookup =
  | { ok: true; node: RunNode; root: string }
  | { ok: false; status: number; error: string };

/**
 * Resolve `(runId, nodeId)` to a node and its task workspace.
 *
 * The workspace is the root every artifact path is checked against, so a node id
 * from another run cannot be used to reach a different task's files.
 */
async function lookupNode(runId: string, nodeId: string, ctx: NodeRouteContext | undefined): Promise<NodeLookup> {
  if (!ctx?.workspace) return { ok: false, status: 409, error: "workspace is not configured" };
  let root: string;
  try {
    root = requireTaskWorkspace(runId, ctx.workspace);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A missing task id is the caller's fault; anything else is a server fault.
    return { ok: false, status: /task not found|taskId required/.test(message) ? 404 : 500, error: message };
  }
  const node = getRunNode(nodeId, runId);
  if (!node) return { ok: false, status: 404, error: "node not found in this run" };
  return { ok: true, node, root };
}

/**
 * Handle `/api/graph/:runId/nodes/:nodeId/{versions,diff,knowledge,artifact}`.
 * Returns true when the path belongs to this module so `startServer` can stop.
 */
export async function handleGraphNodeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  rawPath: string,
  ctx: NodeRouteContext | undefined = undefined,
): Promise<boolean> {
  const match = rawPath.match(/^\/api\/graph\/([^/]+)\/nodes\/([^/]+)\/(versions|diff|knowledge(?:\/preview)?|artifact(?:\.zip)?|preview)$/);
  if (!match) return false;
  const runId = decodeURIComponent(match[1]!);
  const nodeId = decodeURIComponent(match[2]!);
  const action = match[3]!;

  try {
    const found = await lookupNode(runId, nodeId, ctx);
    if (!found.ok) return sendJson(res, found.status, { error: found.error });
    const { node, root } = found;
    const versions = listVersionsForNode(node.id);

    // ---- version history ----
    if (action === "versions" && req.method === "GET") {
      const files = listFileVersions(node.id);
      return sendJson(res, 200, {
        nodeId: node.id,
        runId,
        type: node.type,
        current: versions.length,
        versions,
        // File versions are the captured assets beside the page, so the archive
        // can carry them even when the workspace was cleaned.
        files,
      });
    }

    // ---- capture the node's current text as a new version ----
    if (action === "versions" && req.method === "POST") {
      if (isCrossSite(req)) return sendJson(res, 403, { error: "same-origin requests required" });
      // A malformed body is ignored: capturing the node as it stands is the
      // useful default, and an empty body means exactly that.
      const body = await readJsonBody(req, MAX_BODY_BYTES).catch(() => ({} as Record<string, unknown>));
      const content = typeof body.content === "string" ? body.content : nodeCurrentText(node);
      const captured = captureNodeVersion({
        nodeId: node.id,
        runId,
        type: node.type,
        title: nodeTitle(node),
        content,
        nodeVersion: node.version,
        source: "user",
      });
      if (!captured) return sendJson(res, 422, { ok: false, error: "this node carries no text to version" });
      // The captured files let the archive stay complete after a canvas edit.
      captureNodeFilesForNode(node, root);
      return sendJson(res, 201, { ok: true, version: captured.version, versions: listVersionsForNode(node.id) });
    }

    // ---- line diff between two versions ----
    if (action === "diff" && req.method === "GET") {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const pair = resolvePair(versions, url.searchParams.get("from"), url.searchParams.get("to"));
      if (!pair) return sendJson(res, 400, { error: "from/to must be version numbers of this node" });
      const from = versions.find((v) => v.version === pair.from);
      const to = versions.find((v) => v.version === pair.to);
      if (!from || !to) return sendJson(res, 404, { error: "version not found" });
      const diff: DiffResult = diffLines(from.content, to.content);
      return sendJson(res, 200, {
        nodeId: node.id,
        from: pair.from,
        to: pair.to,
        added: diff.added,
        removed: diff.removed,
        unchanged: diff.unchanged,
        empty: diff.empty,
        lines: diff.lines,
        hunks: diff.hunks,
      });
    }

    // ---- "Add to Knowledge Base": preview then ingest ----
    if (action === "knowledge/preview" && req.method === "GET") {
      const content = nodeCurrentText(node);
      const preview = previewNodeSeeds({
        runId,
        nodeId: node.id,
        nodeType: node.type,
        title: nodeTitle(node),
        content,
      });
      return sendJson(res, 200, {
        nodeId: node.id,
        baseName: nodeTitle(node) || "Knowledge Garden",
        count: preview.length,
        seeds: preview,
        warnings: content ? [] : ["this node carries no text"],
      });
    }

    if (action === "knowledge" && req.method === "POST") {
      if (isCrossSite(req)) return sendJson(res, 403, { error: "same-origin requests required" });
      const body = (await readJsonBody(req, MAX_BODY_BYTES)) as {
        baseId?: unknown; baseName?: unknown; tags?: unknown; split?: unknown; version?: unknown;
      };
      const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : [];
      const split = body.split === "fixed" ? "fixed" : "llm";
      const latest = versions.length > 0 ? versions[versions.length - 1] : undefined;
      const result = await ingestNode(
        {
          runId,
          nodeId: node.id,
          nodeType: node.type,
          title: nodeTitle(node),
          content: nodeCurrentText(node),
          tags,
          split,
          ...(typeof body.baseId === "string" && body.baseId ? { baseId: body.baseId } : {}),
          ...(typeof body.baseName === "string" && body.baseName ? { baseName: body.baseName } : {}),
          ...(latest && body.version === undefined ? { version: latest.version } : {}),
        },
        {
          ...(ctx?.embedder ? { embedder: ctx.embedder } : {}),
          ...(ctx?.model ? { model: ctx.model } : {}),
          ...(ctx?.ingestDeps ?? {}),
        },
      );
      return sendJson(res, result.seeds.length > 0 ? 201 : 422, {
        ok: result.seeds.length > 0,
        baseId: result.baseId,
        baseName: result.baseName,
        smartSplit: result.smartSplit,
        seeds: result.seeds.map((seed) => ({
          id: seed.id,
          title: seed.title,
          body: seed.body,
          tags: seed.tags,
          provenance: seed.provenance,
        })),
        warnings: result.warnings,
      });
    }

    // ---- webpage-node artifact: resolve, open, download ----
    if (action === "preview" && req.method === "GET") {
      if (!ctx?.preview) return sendJson(res, 503, { error: "preview unavailable" });
      const artifact = resolveArtifactDir(node, root);
      if (!artifact) return sendJson(res, 404, { error: "no artifact directory for this node" });
      // The preview root is the node's own directory, so the sandbox tab shows
      // the page the agent built rather than the whole task workspace.
      const rel = artifact.dir === root ? "." : path.relative(root, artifact.dir);
      const dir = taskPath(root, rel === "" ? "." : rel);
      let inst;
      try {
        inst = await ctx.preview.start(dir);
      } catch (err) {
        return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      // The preview server serves `/` from the node directory and falls back to
      // its `index.html`, so the entry page is the default view; only an entry
      // other than `index.html` needs an explicit path.
      const suffix = artifact.entry && artifact.entry !== "index.html" ? `/${artifact.entry}` : "/";
      return sendJson(res, 200, { url: `${inst.url}${suffix}`, root: inst.root });
    }

    if (action === "artifact" && req.method === "GET") {
      const artifact = resolveArtifactDir(node, root);
      if (!artifact) return sendJson(res, 404, { error: "no artifact directory for this node" });
      return sendJson(res, 200, {
        nodeId: node.id,
        runId,
        dir: artifact.dir,
        entry: artifact.entry,
        explicit: artifact.explicit,
        // The preview tab is opened at this URL; the server starts the sandbox
        // preview on the node's own directory so the page opens as it was built.
        url: `/api/graph/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(node.id)}/preview`,
        zipUrl: `/api/graph/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(node.id)}/artifact.zip`,
      });
    }

    if (action === "artifact.zip" && req.method === "GET") {
      const artifact = resolveArtifactDir(node, root);
      if (!artifact) return sendJson(res, 404, { error: "no artifact directory for this node" });
      const captured = capturedFileEntries(listFileVersions(node.id));
      // One top-level folder named after the node, so the download extracts into
      // a directory instead of scattering the page across the current folder.
      const zip = buildArtifactZip(artifact.dir, { prefix: archiveName(node), extra: captured });
      if (zip.length > MAX_ARTIFACT_BYTES) {
        return sendJson(res, 413, { error: "artifact is too large to download" });
      }
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${archiveName(node)}.zip"`,
        "content-length": zip.length,
        "cache-control": "no-store",
      });
      res.end(zip);
      return true;
    }

    return sendJson(res, 405, { error: "method not allowed" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return sendJson(res, isUserError(message) ? 400 : 500, { error: message });
  }
}

/** A file name that is safe to use in `content-disposition`. */
function archiveName(node: RunNode): string {
  const title = nodeTitle(node);
  const cleaned = title.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? `node-${cleaned}` : `node-${node.id.slice(0, 12)}`;
}

/** Capture the files a node names, best-effort (capture never throws). */
function captureNodeFilesForNode(node: RunNode, root: string): void {
  try {
    captureNodeFiles({ nodeId: node.id, runId: node.run_id, paths: nodeFiles(node, root), source: "user", root });
  } catch {
    /* capture is best-effort: a failure must not break the canvas action */
  }
}
