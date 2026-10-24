/**
 * Neo N2: the Canvas HTTP surface.
 *
 * The run graph is built live by the agent (N1); this module only reads it, plus
 * the three edits the canvas can make (status, payload, parents). It is mounted
 * inside `startServer`, so the install-token rule that protects every `/api`
 * route applies here too, and the body guard keeps a hand-edited payload from
 * overwhelming the store.
 *
 * Routes (all keyed by `runId`, which is the Loam task id):
 *   GET   /api/graph/:runId?afterSeq=N            -> RunGraphLayout + incremental nodes
 *   GET   /api/graph/:runId/stream                -> SSE of graph changes (live canvas)
 *   PATCH /api/graph/:runId/nodes/:nodeId        -> { status?, data?, parentIds? }
 *   POST  /api/graph/:runId/nodes/:nodeId        -> heartbeat (bump `updated`)
 *   GET   /api/graph/:runId/replay[/json|/html]   -> Neo N14 static replay export
 *   GET   /api/graph/:runId/annotations          -> colour tags + comments + free notes (N18)
 *   PATCH /api/graph/:runId/nodes/:nodeId/colour -> { colour } (N18)
 *   POST  /api/graph/:runId/nodes/:nodeId/comments -> { author?, text } (N18)
 *   DELETE /api/graph/:runId/nodes/:nodeId/comments/:commentId (N18)
 *   POST  /api/graph/:runId/notes                -> { text, x, y, colour? } (N18)
 *   PATCH /api/graph/:runId/notes/:noteId       -> { text?, x?, y?, colour? } (N18)
 *   DELETE /api/graph/:runId/notes/:noteId      (N18)
 *   GET   /api/graph/:runId/ops                 -> the run's pending canvas edits
 *   POST  /api/graph/:runId/ops                 -> one N11 editing operation
 *
 * The `ops` route is the N11 surface: it is the only place the canvas can express
 * an *intent* ("edit this node", "cut this edge", "group these two") rather than a
 * raw field write, so the graph update and the directive that tells the agent
 * about it are always produced together.
 *
 * Neo N18 adds the user-authored layer on top of the agent graph: colour tags,
 * comments and free notes are read and written here (`/annotations`), and `?q=`
 * on the graph search runs the whole run's nodes through the pure search in
 * `src/graph/search.ts` so the canvas can highlight matches in one round.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  applyCanvasRequest,
  getRunGraphLayout,
  getRunNode,
  getRunNodes,
  pendingCanvasDirectives,
  setRunNodeData,
  setRunNodeParents,
  setRunNodeStatus,
  subscribeRunGraph,
} from "../../agent/runGraphAdapter.js";
import {
  buildRunReplay,
  renderReplayHtml,
  replayFileName,
  replayHtmlFileName,
  scanReplayForSecrets,
} from "../../graph/export.js";
import { getTask } from "../db.js";
import { isRunNodeStatus } from "../../graph/store.js";
import { MAX_OP_TEXT_CHARS } from "../../graph/ops.js";
import { searchCanvasNodes } from "../../graph/search.js";
import { getCanvasAnnotationStore, isCanvasTagColour, type CanvasTagColour } from "../canvasNotes.js";

/** A node payload edit is user-authored, so it is capped well below a file upload. */
const MAX_NODE_DATA_BYTES = 64_000;
/** A colour tag, comment or note is small; a cap keeps a paste from swamping the store. */
const MAX_ANNOTATION_BYTES = 8_000;
/** Hard cap on search results, so a one-character query cannot flood the canvas. */
const MAX_SEARCH_RESULTS = 100;

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

/** A cross-site mutation attempt is refused before the graph is touched. */
function isCrossSite(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return Boolean(origin && origin !== `http://${req.headers.host}`) || req.headers["sec-fetch-site"] === "cross-site";
}

interface RouteContext {
  /** Enabled by config; when false the canvas reads are empty rather than 503. */
  enabled?: boolean;
}

/**
 * Handle `/api/graph/*`. Returns true when the path belongs to this module,
 * so `startServer` can stop looking. Unknown graph paths return true with a
 * 404 so they are not silently swallowed by a later handler.
 */
export async function handleGraphRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  rawPath: string,
  ctx: RouteContext | undefined = undefined,
): Promise<boolean> {
  // Neo N14: a self-contained static replay of one run. Matched before the
  // generic `/nodes` route because `/replay` is not a node id.
  const replayMatch = rawPath.match(/^\/api\/graph\/([^/]+)\/replay(?:\/(json|html))?$/);
  if (replayMatch) {
    if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
    const runId = decodeURIComponent(replayMatch[1]!);
    const variant = replayMatch[2] ?? "json";
    const task = getTask(runId);
    if (!task) return sendJson(res, 404, { error: "run not found" });
    const replay = buildRunReplay({
      runId,
      title: task.title,
      // A run that has not reached a terminal state is exported as-is and marked
      // partial, so the viewer says so instead of implying a finished mission.
      // `done` / `error` / `cancelled` are terminal; anything else is partial.
      partial: task.status !== "done" && task.status !== "error" && task.status !== "cancelled",
      nodes: getRunNodes(runId),
    });
    // Re-verify after the run title is folded in: the title is user-authored and
    // is the one field that arrives from outside the node payload.
    const findings = scanReplayForSecrets(replay);
    if (findings.length > 0) return sendJson(res, 500, { error: `run replay rejected: secret at ${findings[0]!.path}` });

    if (variant === "html") {
      const html = renderReplayHtml({ replay });
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html),
        // The page is a standalone file, so a browser must never sniff it into
        // something executable or cache it as an API response.
        "content-disposition": `inline; filename="${replayHtmlFileName(runId)}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      res.end(html);
      return true;
    }

    const text = JSON.stringify(replay);
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text),
      "content-disposition": `attachment; filename="${replayFileName(runId)}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    res.end(text);
    return true;
  }

  // The live canvas subscribes to this stream; it is not a graph resource, so it
  // is matched before the `/nodes` route below.
  const streamMatch = rawPath.match(/^\/api\/graph\/([^/]+)\/stream$/);
  if (streamMatch) {
    if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
    const runId = decodeURIComponent(streamMatch[1]!);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // A proxy must not buffer this stream, or the canvas would only refresh
      // in bursts instead of node by node.
      "x-accel-buffering": "no",
    });
    let closed = false;
    const send = (payload: unknown): void => {
      if (closed || res.destroyed || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    // Push the current graph immediately so the panel is never blank while it
    // waits for the next change.
    const snapshot = getRunGraphLayout(runId);
    send({ type: "snapshot", runId, nodes: snapshot.nodes, edges: snapshot.edges, stats: snapshot.stats });
    const unsubscribe = subscribeRunGraph(runId, (change) => {
      send({ type: "change", ...change });
    });
    // A comment frame keeps the connection warm through an idle proxy.
    const keepAlive = setInterval(() => {
      if (closed || res.destroyed || res.writableEnded) return;
      res.write(`: keep-alive ${Date.now()}\n\n`);
    }, 25_000);
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      unsubscribe();
    };
    req.on("close", close);
    res.on("close", close);
    return true;
  }

  // Neo N11: the editing-operations surface. Matched before `/nodes` so a run id
  // can never be mistaken for a node id.
  const opsMatch = rawPath.match(/^\/api\/graph\/([^/]+)\/ops$/);
  if (opsMatch) {
    const runId = decodeURIComponent(opsMatch[1]!);
    if (req.method === "GET") {
      // The pending edits: what the canvas has told the agent that the agent has
      // not consumed yet. Read-only, so no same-origin check is needed.
      return sendJson(res, 200, { runId, directives: pendingCanvasDirectives(runId) });
    }
    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
    if (isCrossSite(req)) return sendJson(res, 403, { error: "same-origin requests required" });
    const body = await readJsonBody(req, MAX_OP_TEXT_CHARS + 8_000);
    // `undefined` means the payload was not a valid operation: a 400, never a
    // silent no-op the user would read as "the edit worked".
    let result;
    try {
      result = applyCanvasRequest(runId, body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A node that is not in this run, or a group of one, is a client problem.
      return sendJson(res, message.includes("not found") ? 404 : 409, { error: message });
    }
    if (!result) return sendJson(res, 400, { error: "unrecognised canvas operation" });
    // The whole graph, laid out, because several operations create or re-point
    // nodes. The panel must not have to guess which ids appeared, and it needs the
    // edges and stats to redraw the canvas in one write.
    const layout = getRunGraphLayout(runId);
    return sendJson(res, 200, { ...result, nodes: layout.nodes, edges: layout.edges, stats: layout.stats });
  }

  // Neo N18: the annotation layer of a run, read whole. Matched before the
  // generic node route, which would otherwise swallow the `/annotations` tail.
  const annotationsMatch = rawPath.match(/^\/api\/graph\/([^/]+)\/annotations$/);
  if (annotationsMatch) {
    if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
    const runId = decodeURIComponent(annotationsMatch[1]!);
    return sendJson(res, 200, getCanvasAnnotationStore().getAnnotations(runId));
  }

  // Neo N18: free notes are run-scoped resources, so they are matched before the
  // node routes (which would otherwise swallow the `/notes` segment).
  const notesMatch = rawPath.match(/^\/api\/graph\/([^/]+)\/notes(?:\/([^/]+))?$/);
  if (notesMatch) {
    const runId = decodeURIComponent(notesMatch[1]!);
    const noteId = notesMatch[2] ? decodeURIComponent(notesMatch[2]) : undefined;
    return handleNoteRoutes(req, res, runId, noteId);
  }

  // Neo N18: node-scoped annotation edits (colour, comments) sit next to the
  // node's own PATCH route, so they share the node lookup and the 404s.
  const nodeAnnotationMatch = rawPath.match(
    /^\/api\/graph\/([^/]+)\/nodes\/([^/]+)\/(colour|comments)(?:\/([^/]+))?$/,
  );
  if (nodeAnnotationMatch) {
    const runId = decodeURIComponent(nodeAnnotationMatch[1]!);
    const nodeId = decodeURIComponent(nodeAnnotationMatch[2]!);
    const kind = nodeAnnotationMatch[3] as "colour" | "comments";
    const commentId = nodeAnnotationMatch[4] ? decodeURIComponent(nodeAnnotationMatch[4]) : undefined;
    return handleNodeAnnotationRoutes(req, res, runId, nodeId, kind, commentId);
  }

  const match = rawPath.match(/^\/api\/graph\/([^/]+)(?:\/nodes(?:\/([^/]+))?)?$/);
  if (!match) return false;
  const runId = decodeURIComponent(match[1]!);
  const nodeId = match[2] ? decodeURIComponent(match[2]) : undefined;

  try {
    if (req.method === "GET" && !nodeId) {
      // Live canvas polling: `afterSeq` returns only nodes appended after the
      // cursor the panel already rendered, so a running run streams incrementally.
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0");
      // Neo N18: `q` runs the whole run through the search; the reply carries the
      // hits alongside the layout so the canvas can highlight them in one round.
      const query = url.searchParams.get("q") ?? "";
      // The layout is always read: an empty graph is a valid answer for a run
      // that has not started, so the canvas can still show the root question.
      const layout = getRunGraphLayout(runId);
      const nodes = getRunNodes(runId);
      const fresh = Number.isFinite(afterSeq) && afterSeq > 0 ? nodes.filter((n) => (n.position ?? 0) > afterSeq) : [];
      return sendJson(res, 200, {
        runId,
        enabled: ctx?.enabled !== false,
        nodes: layout.nodes,
        edges: layout.edges,
        stats: layout.stats,
        // The panel keeps a stable snapshot and applies `fresh` deltas on top.
        fresh,
        // Present only when the caller asked, so an unfiltered reply is unchanged.
        ...(query.trim()
          ? { search: { query, hits: searchCanvasNodes(nodes, query, { limit: MAX_SEARCH_RESULTS }) } }
          : {}),
      });
    }

    if (req.method === "PATCH" && nodeId) {
      if (isCrossSite(req)) return sendJson(res, 403, { error: "same-origin requests required" });
      const body = await readJsonBody(req, MAX_NODE_DATA_BYTES);
      const status = body.status;
      const data = body.data;
      const parentIds = body.parentIds;

      if (status !== undefined && !isRunNodeStatus(status)) {
        return sendJson(res, 400, { error: "unknown node status" });
      }
      if (parentIds !== undefined && (!Array.isArray(parentIds) || parentIds.some((id) => typeof id !== "string"))) {
        return sendJson(res, 400, { error: "parentIds must be an array of node ids" });
      }

      // The node must belong to this run: a canvas edit can never reach another
      // task's graph, even with a hand-crafted id.
      const existing = getRunNode(nodeId, runId);
      if (!existing) return sendJson(res, 404, { error: "node not found in this run" });

      try {
        let updated = existing;
        if (parentIds !== undefined) updated = setRunNodeParents(nodeId, parentIds as string[], runId);
        if (data !== undefined) updated = setRunNodeData(nodeId, data, runId);
        if (status !== undefined) updated = setRunNodeStatus(nodeId, status, runId);
        return sendJson(res, 200, { node: updated });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // An illegal transition (e.g. reopening a finished node) is a client
        // problem, not a server fault.
        return sendJson(res, message.includes("illegal run node transition") ? 409 : 500, { error: message });
      }
    }

    if (req.method === "POST" && nodeId) {
      if (isCrossSite(req)) return sendJson(res, 403, { error: "same-origin requests required" });
      await readJsonBody(req, 1_000).catch(() => ({}));
      const existing = getRunNode(nodeId, runId);
      if (!existing) return sendJson(res, 404, { error: "node not found in this run" });
      // A heartbeat only stamps the node as recently touched; it changes no state
      // the agent owns, so it is always accepted.
      const touched = setRunNodeData(nodeId, existing.data, runId);
      return sendJson(res, 200, { node: touched });
    }

    return sendJson(res, 405, { error: "method not allowed" });
  } catch (err) {
    return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Map an annotation failure to the status a client should see. */
function annotationStatus(message: string): number {
  if (message.includes("not found")) return 404;
  if (message.includes("limit reached")) return 413;
  return 400;
}

/** Neo N18: write a colour tag, add a comment, or remove a comment. */
async function handleNodeAnnotationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  nodeId: string,
  kind: "colour" | "comments",
  commentId: string | undefined,
): Promise<boolean> {
  const store = getCanvasAnnotationStore();
  // The node must belong to this run, so a hand-crafted id can never tag or
  // comment on another task's graph.
  const nodeExists = (id: string): boolean => getRunNode(id, runId) !== undefined;
  try {
    if (kind === "colour") {
      if (req.method !== "PATCH") return sendJson(res, 405, { error: "method not allowed" });
      if (isCrossSite(req)) return sendJson(res, 403, { error: "same-origin requests required" });
      const body = await readJsonBody(req, MAX_ANNOTATION_BYTES);
      const colour = body.colour;
      if (!isCanvasTagColour(colour)) return sendJson(res, 400, { error: "colour must be one of the canvas palette" });
      const applied = store.setColour(runId, nodeId, colour, nodeExists);
      return sendJson(res, 200, { node: { id: nodeId, run_id: runId, colour: applied } });
    }

    if (req.method === "POST") {
      if (isCrossSite(req)) return sendJson(res, 403, { error: "same-origin requests required" });
      const body = await readJsonBody(req, MAX_ANNOTATION_BYTES);
      const text = body.text;
      if (typeof text !== "string") return sendJson(res, 400, { error: "comment text is required" });
      const author = typeof body.author === "string" ? body.author : "user";
      const comment = store.addComment(runId, nodeId, author, text, nodeExists);
      return sendJson(res, 200, { comment });
    }

    if (req.method === "DELETE" && commentId) {
      if (isCrossSite(req)) return sendJson(res, 403, { error: "same-origin requests required" });
      const removed = store.removeComment(runId, nodeId, commentId);
      return sendJson(res, removed ? 200 : 404, { removed });
    }

    return sendJson(res, 405, { error: "method not allowed" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return sendJson(res, annotationStatus(message), { error: message });
  }
}

/** Neo N18: create, edit and delete the run's free notes. */
async function handleNoteRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  noteId: string | undefined,
): Promise<boolean> {
  const store = getCanvasAnnotationStore();
  try {
    if (req.method === "POST" && !noteId) {
      if (isCrossSite(req)) return sendJson(res, 403, { error: "same-origin requests required" });
      const body = await readJsonBody(req, MAX_ANNOTATION_BYTES);
      const text = body.text;
      if (typeof text !== "string") return sendJson(res, 400, { error: "note text is required" });
      const x = Number(body.x);
      const y = Number(body.y);
      const colour = body.colour;
      const note = store.addNote(
        runId,
        text,
        Number.isFinite(x) ? x : 0,
        Number.isFinite(y) ? y : 0,
        isCanvasTagColour(colour) ? colour : "none",
      );
      return sendJson(res, 200, { note });
    }

    if (!noteId) return sendJson(res, 405, { error: "method not allowed" });

    if (req.method === "PATCH") {
      if (isCrossSite(req)) return sendJson(res, 403, { error: "same-origin requests required" });
      const body = await readJsonBody(req, MAX_ANNOTATION_BYTES);
      const x = Number(body.x);
      const y = Number(body.y);
      const patch: { text?: string; colour?: CanvasTagColour } = {};
      if (typeof body.text === "string") patch.text = body.text;
      if (isCanvasTagColour(body.colour)) patch.colour = body.colour;
      let note = store.updateNote(runId, noteId, patch);
      // A move is a coordinate change, which the same PATCH carries alongside text.
      if (Number.isFinite(x) || Number.isFinite(y)) {
        const current = note ?? store.getAnnotations(runId).notes.find((entry) => entry.id === noteId);
        note = store.moveNote(
          runId,
          noteId,
          Number.isFinite(x) ? x : current?.x ?? 0,
          Number.isFinite(y) ? y : current?.y ?? 0,
        );
      }
      if (!note) return sendJson(res, 404, { error: "note not found" });
      return sendJson(res, 200, { note });
    }

    if (req.method === "DELETE") {
      if (isCrossSite(req)) return sendJson(res, 403, { error: "same-origin requests required" });
      const removed = store.removeNote(runId, noteId);
      return sendJson(res, removed ? 200 : 404, { removed });
    }

    return sendJson(res, 405, { error: "method not allowed" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return sendJson(res, annotationStatus(message), { error: message });
  }
}
