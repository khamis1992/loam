import type { MemoryStore } from "../memory/store.js";
import type { WriteGate } from "../server/pending.js";
import { gateActive } from "../server/settings.js";
import type { Tool, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";

export interface MemoryToolOptions {
  onApply?: (label: string) => void;
  gate?: WriteGate;
}

export function createMemoryTools(store: MemoryStore, opts: MemoryToolOptions = {}): Tool[] {
  const { onApply, gate } = opts;
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
          const item = gate.stage("memory_store", `memory_store [${kind}]: ${text.slice(0, 100)}`, { text, kind, tags });
          onApply?.(`staged memory_store (${item.id})`);
          return {
            ok: true,
            content: `staged for approval (id=${item.id}); it is not searchable until approved at /learning.html or POST /api/pending/${item.id}/approve`,
          };
        }
        try {
          const entry = await store.add(text, { kind, tags });
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
