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
 *   POST  /api/graph/:runId/ops                  -> one N11 editing operation
 *
 * The `ops` route is the N11 surface: it is the only place the canvas can express
 * an *intent* ("edit this node", "cut this edge", "group these two") rather than a
 * raw field write, so the graph update and the directive that tells the agent
 * about it are always produced together.
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
import { isRunNodeStatus } from "../../graph/store.js";
import { MAX_OP_TEXT_CHARS } from "../../graph/ops.js";

/** A node payload edit is user-authored, so it is capped well below a file upload. */
const MAX_NODE_DATA_BYTES = 64_000;

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
