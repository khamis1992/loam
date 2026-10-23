import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import type { RunNode } from "../../graph/store.js";
import { log } from "../../log.js";
import {
  getRunGraphLayout,
  getRunNode,
  getRunNodes,
  addCanvasBridgeNode,
  getRunChildren,
  getLiveRunGraph,
  subscribeRunGraph,
  setRunNodeData,
  setRunNodeParents,
  setRunNodeStatus,
} from "../../agent/runGraphAdapter.js";
import {
  coerceBridgeNodePatch,
  getCanvasBridgeStatus,
  CANVAS_BRIDGE_NODE_TYPE,
  isBatchPayload,
  registerCanvasBridgeIdentity,
  submitCanvasBridgeBatch,
  submitCanvasBridgeRequest,
  toPublicBridgeNode,
  type CanvasBridgeGraph,
  type CanvasBridgeRunTask,
} from "../bridge/canvasBridge.js";
import { handleBridgeUpgrade } from "../bridge/canvasBridgeSocket.js";

/**
 * The live `RunGraph` narrowed to the bridge's write surface.
 *
 * The bridge core depends on this shape rather than on `RunGraph`, so it can be
 * exercised with a stub graph in tests; the adapter's own setters already publish
 * each write on the graph bus, which is what the live canvas and the bridge
 * socket subscribe to.
 */
function bridgeGraph(): CanvasBridgeGraph {
  const graph = getLiveRunGraph();
  return {
    addExternalNode: (runId, spec) => addCanvasBridgeNode(runId, spec),
    setStatus: (nodeId, status, runId) => setRunNodeStatus(nodeId, status, runId),
    setData: (nodeId, data, runId) => setRunNodeData(nodeId, data, runId),
    list: (runId) => getRunNodes(runId),
    children: (parentId, runId) => getRunChildren(parentId, runId),
    subscribe: (runId, listener) => subscribeRunGraph(runId, listener),
    invalidate: (runId) => graph.invalidate(runId),
  };
}

/**
 * Neo N17: the external-agent canvas bridge routes.
 *
 *   POST /api/bridge/canvas/identity {canvasId?, agentId?}   -> register a session
 *   POST /api/bridge/canvas/submit  {canvasId?, prompt, ...}  -> one request/run
 *   POST /api/bridge/canvas/batch   {canvasId?, nodes:[...]}  -> fan-out
 *   GET  /api/bridge/canvas/:canvasId/status                  -> canvas state
 *   GET  /api/bridge/canvas/:canvasId/nodes?parent=&type=    -> nodes + layout
 *   GET  /api/bridge/canvas/:canvasId/result/:nodeId         -> one node
 *   GET  /api/bridge/canvas/:canvasId/follow/:nodeId         -> block until settled
 *   PATCH /api/bridge/canvas/:canvasId/nodes                  -> edit nodes
 *   GET  /api/bridge/canvas/:canvasId/stream                 -> live SSE
 *   WS   /api/bridge/canvas/:canvasId/ws                     -> live WebSocket
 *
 * Mounted inside `startServer`, so the install token that protects every `/api`
 * route applies here too: an external session authenticates with the same local
 * token the Electron renderer uses (`x-loam-local-token`).
 *
 * The WebSocket upgrade is a real upgrade on the loopback server rather than a
 * second listener: the external agent (OpenCode / Claude Code / Orca) speaks HTTP
 * for commands and holds one socket for live node changes, exactly like the
 * browser canvas holds its SSE stream.
 */

/** A bridge payload is agent-authored, so it is capped well below an upload. */
const MAX_BODY_BYTES = 256_000;
const MAX_NODE_IDS = 64;
const MAX_FOLLOW_MS = 5 * 60_000;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
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

/** A cross-site mutation attempt is refused before the canvas is touched. */
function isCrossSite(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  return Boolean(origin && origin !== `http://${req.headers.host}`) || req.headers["sec-fetch-site"] === "cross-site";
}

/** The run engine, exposed on globalThis by `src/index.ts` (routes get no deps). */
function runTaskRef(): CanvasBridgeRunTask | undefined {
  const candidate = (globalThis as { __loamRunTask?: unknown }).__loamRunTask;
  return typeof candidate === "function" ? (candidate as CanvasBridgeRunTask) : undefined;
}

/** Port the CLI and the skill doc need to reach this process. */
export function canvasBridgePort(server: http.Server): number {
  const address = server.address() as AddressInfo | null;
  return address && typeof address === "object" ? address.port : 0;
}

function decode(raw: string): string {
  return decodeURIComponent(raw);
}

/** Everything a follow/result caller needs to know about one node. */
function nodeResult(runId: string, nodeId: string): { node: unknown } | undefined {
  const node = getRunNode(nodeId, runId);
  return node ? { node: toPublicBridgeNode(node) } : undefined;
}

/** Block until the node leaves `running`, or the timeout passes. */
async function waitForNode(runId: string, nodeId: string, timeoutMs: number): Promise<RunNode | undefined> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  for (;;) {
    const node = getRunNode(nodeId, runId);
    if (!node) return undefined;
    if (node.status !== "running") return node;
    if (Date.now() >= deadline) return node;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

interface RouteContext {
  /** Enabled by config; when false the bridge answers 503 instead of writing. */
  enabled?: boolean;
  /** The process-wide live graph, for tests that inject their own. */
  graph?: CanvasBridgeGraph;
}

/** Open the SSE stream for one canvas and keep it alive until the peer leaves. */
function openStream(req: http.IncomingMessage, res: http.ServerResponse, runId: string): true {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  // A proxy must not buffer this stream, or the canvas would refresh in bursts
  // instead of node by node.
  res.setHeader("x-accel-buffering", "no");
  const send = (payload: unknown): void => {
    if (res.destroyed || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  // Push the current graph first, so a fresh peer is never blank while it waits
  // for the next change.
  const layout = getRunGraphLayout(runId);
  send({ type: "snapshot", runId, nodes: layout.nodes, edges: layout.edges, stats: layout.stats });
  const unsubscribe = subscribeRunGraph(runId, (change) => send({ type: "change", ...change }));
  const keepAlive = setInterval(() => {
    if (res.destroyed || res.writableEnded) return clearInterval(keepAlive);
    res.write(`: keep-alive ${Date.now()}\n\n`);
  }, 25_000);
  const close = (): void => {
    clearInterval(keepAlive);
    unsubscribe();
  };
  req.on("close", close);
  res.on("close", close);
  return true;
}

/**
 * Handle `/api/bridge/canvas/*`. Returns true when the path belongs to this
 * module, so `startServer` can stop looking.
 */
export async function handleCanvasBridgeRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawPath: string,
  ctx: RouteContext | undefined = undefined,
): Promise<boolean> {
  if (!rawPath.startsWith("/api/bridge/canvas")) return false;
  if (ctx?.enabled === false) {
    return (sendJson(res, 503, { error: "canvas bridge is disabled" }), true);
  }
  // The canvas is the run graph, reached through the adapter rather than a global:
  // route modules cannot receive it through `startServer` deps.
  const graph: CanvasBridgeGraph = ctx?.graph ?? bridgeGraph();

  const streamMatch = rawPath.match(/^\/api\/bridge\/canvas\/([^/]+)\/stream$/);
  if (streamMatch) {
    if (req.method !== "GET") return (sendJson(res, 405, { error: "method not allowed" }), true);
    return openStream(req, res, decode(streamMatch[1]!));
  }

  const canvasMatch = rawPath.match(
    /^\/api\/bridge\/canvas\/([\w.:-]+)(?:\/(status|nodes|result(?:\/([\w.:-]+))?|follow(?:\/([\w.:-]+))?))?$/,
  );
  const action = canvasMatch?.[2];

  try {
    if (req.method === "POST" && rawPath === "/api/bridge/canvas/identity") {
      if (isCrossSite(req)) return (sendJson(res, 403, { error: "same-origin requests required" }), true);
      const body = await readJson(req);
      sendJson(res, 200, registerCanvasBridgeIdentity(graph, body));
      return true;
    }

    if (req.method === "POST" && rawPath === "/api/bridge/canvas/submit") {
      if (isCrossSite(req)) return (sendJson(res, 403, { error: "same-origin requests required" }), true);
      const body = await readJson(req);
      const result = submitCanvasBridgeRequest(graph, runTaskRef(), body);
      const payload = nodeResult(result.canvasId, result.nodeId ?? "");
      // `--follow <id>`: block the reply until the node settles, so the CLI (and
      // any agent) gets the finished node in one round trip.
      if (body.follow === true && result.nodeId) {
        const settled = await waitForNode(result.canvasId, result.nodeId, MAX_FOLLOW_MS);
        sendJson(res, 200, { ...result, ...(payload ?? {}), status: settled?.status ?? result.status });
        return true;
      }
      sendJson(res, 202, { ...result, ...(payload ?? {}) });
      return true;
    }

    if (req.method === "POST" && rawPath === "/api/bridge/canvas/batch") {
      if (isCrossSite(req)) return (sendJson(res, 403, { error: "same-origin requests required" }), true);
      const body = await readJson(req);
      if (!isBatchPayload(body)) return (sendJson(res, 400, { error: "batch needs a nodes or tasks array" }), true);
      sendJson(res, 202, submitCanvasBridgeBatch(graph, runTaskRef(), body));
      return true;
    }

    if (!canvasMatch) return (sendJson(res, 404, { error: "not found" }), true);
    const runId = decode(canvasMatch[1]!);

    if (req.method === "GET" && action === "status") {
      const status = getCanvasBridgeStatus(graph, runId);
      if (!status) return (sendJson(res, 404, { error: "canvas not found" }), true);
      return (sendJson(res, 200, status), true);
    }

  if (req.method === "GET" && action === "nodes") {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const parent = url.searchParams.get("parent") ?? undefined;
    const type = url.searchParams.get("type") ?? undefined;
    const layout = getRunGraphLayout(runId);
    const nodes = getRunNodes(runId)
      .filter((node) => (parent ? node.parent_ids.includes(parent) : true))
      .filter((node) => (type ? node.type === type : true))
      .slice(0, MAX_NODE_IDS);
    sendJson(res, 200, {
      runId,
      nodes: nodes.map(toPublicBridgeNode),
      layout: { nodes: layout.nodes, edges: layout.edges, stats: layout.stats },
    });
    return true;
  }

    if (req.method === "GET" && action === "result" && canvasMatch[3]) {
      const nodeId = decode(canvasMatch[3]);
      const found = nodeResult(runId, nodeId);
      if (!found) return (sendJson(res, 404, { error: "node not found on this canvas" }), true);
      sendJson(res, 200, found);
      return true;
    }

    if (req.method === "GET" && action === "follow") {
      const nodeId = canvasMatch[4] ? decode(canvasMatch[4]) : undefined;
      if (!nodeId) return (sendJson(res, 400, { error: "follow needs a node id" }), true);
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const requested = Number(url.searchParams.get("timeoutMs") ?? MAX_FOLLOW_MS);
      const timeoutMs = Math.min(MAX_FOLLOW_MS, Math.max(1, Number.isFinite(requested) ? requested : MAX_FOLLOW_MS));
      const settled = await waitForNode(runId, nodeId, timeoutMs);
      if (!settled) return (sendJson(res, 404, { error: "node not found on this canvas" }), true);
      sendJson(res, 200, { node: toPublicBridgeNode(settled) });
      return true;
    }

    if (req.method === "PATCH" && action === "nodes") {
      if (isCrossSite(req)) return (sendJson(res, 403, { error: "same-origin requests required" }), true);
      const body = await readJson(req);
      const patches = coerceBridgeNodePatch(body.nodes);
      const updated: unknown[] = [];
      for (const patch of patches) {
        const existing = getRunNode(patch.id, runId);
        if (!existing) return (sendJson(res, 404, { error: `node not found on this canvas: ${patch.id}` }), true);
        try {
          let node = existing;
          if (patch.status !== undefined) node = setRunNodeStatus(patch.id, patch.status, runId);
          if (patch.data !== undefined) node = setRunNodeData(patch.id, patch.data, runId);
          updated.push(toPublicBridgeNode(node));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return (sendJson(res, message.includes("illegal run node transition") ? 409 : 500, { error: message }), true);
        }
      }
      sendJson(res, 200, { runId, nodes: updated });
      return true;
    }

    return (sendJson(res, 405, { error: "method not allowed" }), true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`canvas bridge: ${req.method} ${rawPath} failed: ${message}`);
    // A client problem (bad canvas id, bad body) is 400; anything else is a fault.
    const status = /not found|needs a|must be|too large|too long|already running|invalid|unknown/.test(message) ? 400 : 500;
    return (sendJson(res, status, { error: message }), true);
  }
}

/** Parent re-pointing is a separate concern from status/data, so it is its own route. */
export async function handleCanvasBridgeParentRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawPath: string,
  ctx: RouteContext | undefined = undefined,
): Promise<boolean> {
  const match = rawPath.match(/^\/api\/bridge\/canvas\/([^/]+)\/nodes\/([^/]+)$/);
  if (!match || req.method !== "PATCH") return false;
  if (!ctx?.graph) return (sendJson(res, 503, { error: "run graph is not available" }), true);
  if (isCrossSite(req)) return (sendJson(res, 403, { error: "same-origin requests required" }), true);
  const runId = decode(match[1]!);
  const nodeId = decode(match[2]!);
  try {
    const body = await readJson(req);
    const parentIds = body.parentIds;
    if (!Array.isArray(parentIds) || parentIds.some((id) => typeof id !== "string")) {
      return (sendJson(res, 400, { error: "parentIds must be an array of node ids" }), true);
    }
    const node = getRunNode(nodeId, runId);
    if (!node) return (sendJson(res, 404, { error: "node not found on this canvas" }), true);
    sendJson(res, 200, { node: toPublicBridgeNode(setRunNodeParents(nodeId, parentIds as string[], runId)) });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return (sendJson(res, /not found|must be|invalid/.test(message) ? 400 : 500, { error: message }), true);
  }
}

interface UpgradeDeps {
  /** Validate the install token; the same rule every `/api` route uses. */
  authenticate: (req: http.IncomingMessage) => boolean;
  /** Subscribe to graph changes so the socket can push live node updates. */
  subscribe: (canvasId: string, listener: (change: { runId: string; nodeIds: string[]; seq: number }) => void) => () => void;
}

/**
 * Build the WebSocket upgrade handler for `/api/bridge/canvas/:canvasId/ws`.
 *
 * Returned to `startServer`, which registers it on the server's `upgrade` event.
 * The socket is server-push: the agent reads node changes as the canvas changes,
 * and an unexpected inbound message is ignored rather than answered.
 */
export function createCanvasBridgeUpgrade(deps: UpgradeDeps): (req: http.IncomingMessage, socket: Socket, head: Buffer) => boolean {
  return (req, socket, head) =>
    handleBridgeUpgrade(req, socket, head, {
      authenticate: deps.authenticate,
      resolve: (request) => {
        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
        const match = url.pathname.match(/^\/api\/bridge\/canvas\/([^/]+)\/ws$/);
        if (!match) return undefined;
        const canvasId = decode(match[1]!);
        return {
          canvasId,
          onSocket: (ws) => {
            const unsubscribe = deps.subscribe(canvasId, (change) => {
              ws.send({ type: "change", ...change, nodes: change.nodeIds.map((id) => nodeResult(canvasId, id)?.node).filter((n) => n !== undefined) });
            });
            return unsubscribe;
          },
        };
      },
    });
}
