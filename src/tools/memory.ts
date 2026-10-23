import type { MemoryStore } from "../memory/store.js";
import type { WriteGate } from "../server/pending.js";
import { gateActive } from "../server/settings.js";
import type { Tool, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";
import {
  recallIndex,
  type RecallAttacher,
  type RecallHit,
  type RecallMedium,
  type RecallNode,
  type RecallQuery,
} from "../graph/recall.js";

/** Deps the recall tools need; all optional so the tools always register. */
export interface RecallToolOptions {
  /** The shelf. Omitted => the process-wide one, created on first use. */
  index?: import("../graph/recall.js").RecallIndex;
  /** Files a hit back into the current run as a linked node. */
  attach?: RecallAttacher;
  /** The run the calling agent belongs to (used by `recall` to attach). */
  runId?: string;
}

/** Render one hit the way the agent reads it. */
export function formatRecallHit(hit: RecallHit, index: number): string {
  const { node } = hit;
  const bits: string[] = [];
  bits.push(`${index}. [${node.medium}] ${node.type}`);
  bits.push(`from run ${node.runId} node ${node.nodeId}`);
  if (hit.channel === "vector") bits.push(`score ${hit.score.toFixed(3)}`);
  if (node.path) bits.push(`file ${node.path}`);
  const url = dataUrl(node);
  if (url) bits.push(`url ${url}`);
  const text = node.text.trim();
  bits.push(text.length > 600 ? `${text.slice(0, 600)}…` : text);
  return bits.join(" | ");
}

/** Read a string field off a hit's payload without assuming its shape. */
function dataUrl(node: RecallNode): string | undefined {
  if (typeof node.data !== "object" || node.data === null) return undefined;
  const value = (node.data as Record<string, unknown>)["url"];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Neo N16: the cross-run recall tools.
 *
 * `recall` is the bookshelf read: it searches finished nodes (text, image,
 * webpage, video) from earlier runs by description and, when the caller gives
 * it an attaching function, files the chosen hit into the current run as a node
 * that links back to its origin. `recall_status` reports what the shelf holds.
 *
 * Both are throwaway-safe: an unavailable shelf answers "(nothing recalled yet)"
 * rather than an error, because a recall miss must never break the task.
 */
export function createRecallTools(opts: RecallToolOptions = {}): Tool[] {
  const { attach, runId } = opts;
  const index = opts.index ?? recallIndex();

  const runRecall: Tool = {
    name: "recall",
    description:
      "Search your past runs' finished nodes (documents, webpages, images, videos) by description and pull one back into the current run. Use it to reuse an asset you made earlier instead of regenerating it. With node_id it attaches that node to the current run and returns the linked node id; without it, it lists candidates.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you are looking for, in plain words (e.g. \"the dashboard image from the Nutrio report\")." },
        limit: { type: "number", description: "Max candidates (default 5, max 20)." },
        medium: { type: "string", description: "Restrict to one medium: text | image | webpage | video." },
        node_id: { type: "string", description: "Attach this recalled node id to the current run." },
      },
      required: ["query"],
    },
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      const query = str(args, "query").trim();
      if (!query) return { ok: false, content: "recall requires a query" };
      const limit = Math.min(Math.max(num(args, "limit", 5), 1), 20);
      const mediumRaw = str(args, "medium", "").trim();
      const medium = mediumRaw ? (mediumRaw as RecallMedium) : undefined;
      if (medium && !["text", "image", "webpage", "video"].includes(medium)) {
        return { ok: false, content: `recall: unknown medium "${mediumRaw}" (use text|image|webpage|video)` };
      }
      const node_id = str(args, "node_id", "").trim();
      const filter: RecallQuery = { query, limit, ...(medium ? { mediums: [medium] } : {}) };
      try {
        if (node_id) {
          // Look the node up first: "not on the shelf" is the real answer even
          // when this run cannot attach, so the model is not misled.
          const hit = index.get(node_id);
          if (!hit) return { ok: false, content: `recall: node ${node_id} is not on the shelf` };
          if (!attach) return { ok: false, content: "recall: attaching is not wired into this run; use it read-only" };
          if (!runId) return { ok: false, content: "recall: no run context, so the hit cannot be attached" };
          const attached = attach(
            { nodeId: hit.nodeId, runId: hit.runId, type: hit.type },
            runId,
            query,
          );
          if (!attached) return { ok: false, content: `recall: could not attach ${node_id} to run ${runId}` };
          return {
            ok: true,
            content: `attached node ${attached.id} to run ${runId}\nrecalled from ${hit.runId} (${hit.type}, ${hit.nodeId})\n${hit.text.slice(0, 400)}`,
          };
        }
        const hits = await index.search(filter);
        if (hits.length === 0) return { ok: true, content: "(nothing recalled yet for that description)" };
        return {
          ok: true,
          content: `${hits.length} recalled node(s):\n${hits.map((hit, i) => formatRecallHit(hit, i + 1)).join("\n")}\n\nTo reuse one, call recall again with node_id set to its node id.`,
        };
      } catch (err) {
        return { ok: false, content: `recall failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };

  const runRecallStatus: Tool = {
    name: "recall_status",
    description: "Report how many finished nodes from past runs are on the recall shelf, and whether vector search is available.",
    parameters: { type: "object", properties: {} },
    async run(): Promise<ToolResult> {
      try {
        const stats = index.stats();
        return {
          ok: true,
          content: `recall shelf: ${stats.nodes} node(s), ${stats.vectorized} vectorized, ${stats.lexicalOnly ? "lexical-only (no embedder)" : `model ${stats.model || "unknown"}`}`,
        };
      } catch (err) {
        return { ok: false, content: `recall_status failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };

  return [runRecall, runRecallStatus];
}

export interface MemoryToolOptions {
  onApply?: (label: string) => void;
  gate?: WriteGate;
  /** Provenance: session/task id bound to these tools, if known. */
  sessionId?: string;
}

export function createMemoryTools(store: MemoryStore, opts: MemoryToolOptions = {}): Tool[] {
  const { onApply, gate, sessionId } = opts;
  return [
    {
      name: "memory_store",
      description:
        "Save a durable fact/preference/result to long-term semantic memory (embedded locally with Ollama). Use it for things worth recalling in future tasks.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The fact to remember (self-contained, one or two sentences)." },
          kind: { type: "string", description: "Category, e.g. fact, preference, note." },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["text"],
      },
      async run(args: Record<string, unknown>): Promise<ToolResult> {
        const text = str(args, "text").trim();
        if (!text) return { ok: false, content: "memory_store requires text" };
        const kind = str(args, "kind", "note");
        const tags = Array.isArray(args["tags"]) ? (args["tags"] as unknown[]).map((t) => String(t)) : [];
        if (gate && gateActive()) {
          const item = gate.stage("memory_store", `memory_store [${kind}]: ${text.slice(0, 100)}`, { text, kind, tags, ...(sessionId ? { sessionId } : {}) });
          onApply?.(`staged memory_store (${item.id})`);
          return {
            ok: true,
            content: `staged for approval (id=${item.id}); it is not searchable until approved at /learning.html or POST /api/pending/${item.id}/approve`,
          };
        }
        try {
          const entry = await store.add(text, { kind, tags, ...(sessionId ? { sessionId } : {}) });
          onApply?.(`memory_store ${entry.id}`);
          return { ok: true, content: `stored ${entry.id} (kind=${entry.kind}, dim=${entry.dim}); memory now has ${store.count} entries` };
        } catch (err) {
          return { ok: false, content: `memory_store failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "memory_search",
      description: "Semantic search over long-term memory (vector similarity). Returns the closest memories with scores.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", description: "Max results (default 5)." },
        },
        required: ["query"],
      },
      async run(args: Record<string, unknown>): Promise<ToolResult> {
        try {
          const hits = await store.search(str(args, "query"), Math.min(Math.max(num(args, "limit", 5), 1), 20), -1);
          if (hits.length === 0) return { ok: true, content: "(memory is empty)" };
          return {
            ok: true,
            content: hits.map((h) => `${h.score.toFixed(3)}  [${h.entry.kind}] ${h.entry.text}`).join("\n"),
          };
        } catch (err) {
          return { ok: false, content: `memory_search failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "memory_list",
      description: "List the most recent long-term memories (no query).",
      parameters: { type: "object", properties: { limit: { type: "number" } } },
      async run(args: Record<string, unknown>): Promise<ToolResult> {
        const items = store.list(Math.min(Math.max(num(args, "limit", 30), 1), 200));
        if (items.length === 0) return { ok: true, content: "(memory is empty)" };
        return { ok: true, content: items.map((e) => `${e.id}  [${e.kind}] ${e.createdAt.slice(0, 16)}  ${e.text}`).join("\n") };
      },
    },
    {
      name: "memory_delete",
      description: "Delete one memory entry by id.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      async run(args: Record<string, unknown>): Promise<ToolResult> {
        const id = str(args, "id");
        const deleted = store.remove(id);
        return { ok: deleted, content: deleted ? `deleted ${id}` : `not found: ${id}` };
      },
    },
  ];
}
