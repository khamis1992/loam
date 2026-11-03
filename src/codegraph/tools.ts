import type { Tool, ToolContext, ToolResult } from "../tools/registry.js";
import { bool, num, str, strs } from "../tools/registry.js";
import type { CodeGraphService } from "./service.js";
import type { CodeGraphQueryRequest } from "./types.js";

/** Tool names. Every one is a READ tool and an UNTRUSTED-content tool (riskTier wiring: INTEGRATION_SPEC §7.5). */
export const CODEGRAPH_TOOL_NAMES = [
  "codegraph_status",
  "codegraph_index",
  "codegraph_query",
  "codegraph_node",
  "codegraph_neighbors",
  "codegraph_path",
  "codegraph_affected",
  "codegraph_hubs",
  "codegraph_community",
] as const;
export type CodeGraphToolName = (typeof CODEGRAPH_TOOL_NAMES)[number];

const NAME = { type: "string", description: "Symbol or file name as it appears in code (e.g. registerMcpTools, src/tools/mcp.ts). Exact names beat descriptions." };

async function answer(svc: CodeGraphService, ctx: ToolContext, req: CodeGraphQueryRequest): Promise<ToolResult> {
  const r = await svc.query(ctx.workspace, req);
  return { ok: r.ok || r.outcome === "not-indexed", content: r.text };
}

export function createCodeGraphTools(svc: CodeGraphService): Tool[] {
  return [
    {
      name: "codegraph_status",
      description: "Report whether the current project has a Code Graph (persistent knowledge graph of symbols, imports, calls and inheritance built locally with tree-sitter), its freshness versus git HEAD, and node/edge counts. Call once per task before relying on codegraph_* answers.",
      parameters: { type: "object", properties: {} },
      async run(_a, ctx): Promise<ToolResult> {
        const s = await svc.status(ctx.workspace);
        const lines = [
          `state: ${s.state}${s.staleReasons.length ? ` (${s.staleReasons.join(", ")})` : ""}`,
          `engine: ${s.runtime}`, `opted in: ${s.optedIn}${s.declined ? " (user declined; do not ask again)" : ""}`,
          `built at: ${s.builtAtCommit ?? "-"}  HEAD: ${s.headCommit ?? "-"}`,
          `nodes: ${s.nodes ?? "-"}  edges: ${s.edges ?? "-"}  communities: ${s.communities ?? "-"}`,
          s.lastJob ? `last job: ${s.lastJob.status} (${s.lastJob.trigger}) ${s.lastJob.durationMs ?? "-"} ms${s.lastJob.error ? ` — ${s.lastJob.error}` : ""}` : "last job: none",
        ];
        return { ok: true, content: lines.join("\n") };
      },
    },
    {
      name: "codegraph_index",
      description: "Build or refresh the Code Graph for the current project (incremental by default; only changed files are re-parsed). Only works for projects the user enabled in Services › خريطة الكود — you cannot enable it yourself. When NOT to use: right after codegraph_status says ready; never in a loop.",
      parameters: {
        type: "object",
        properties: {
          full: { type: "boolean", description: "Re-parse every file (default false). Use only when answers look wrong after a large refactor." },
          wait: { type: "boolean", description: "Wait up to 180 s for the job to finish (default true)." },
        },
      },
      async run(args, ctx): Promise<ToolResult> {
        try {
          const job = svc.indexer.requestIndex(ctx.workspace, "tool", { full: bool(args, "full", false) });
          if (!bool(args, "wait", true)) return { ok: true, content: `queued ${job.id}` };
          const done = await svc.indexer.waitFor(job.id, 180_000);
          if (!done) return { ok: true, content: `${job.id} still running; call codegraph_status later.` };
          return {
            ok: done.status === "succeeded",
            content: done.status === "succeeded"
              ? `indexed: ${done.nodes} nodes, ${done.edges} edges, ${done.communities} communities in ${done.durationMs} ms (${done.filesReextracted ?? "all"} files re-parsed, ${done.oversizedExcluded ?? 0} oversized files skipped)`
              : `index ${done.status}: ${done.error ?? ""}`,
          };
        } catch (err) {
          return { ok: false, content: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: "codegraph_query",
      description: "Ask the project's Code Graph a question and get a scoped subgraph (nodes with path:line, edges with relation and EXTRACTED/INFERRED tags) instead of reading many files. Works best with concrete identifiers in the question. When NOT to use: to read code bodies (use file_read on the returned locations) or for text/regex hits (use grep).",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "Question or keywords, ideally naming symbols or files." },
          mode: { type: "string", enum: ["bfs", "dfs"], description: "bfs = broad context (default), dfs = follow one chain." },
          depth: { type: "number", description: "Traversal depth 1-6 (default 3)." },
          token_budget: { type: "number", description: "Max answer tokens, 200-8000 (default 2000)." },
          context_filter: { type: "array", items: { type: "string" }, description: "Edge contexts to keep, e.g. [\"call\"]." },
        },
        required: ["question"],
      },
      async run(args, ctx) {
        const mode = str(args, "mode") === "dfs" ? "dfs" : "bfs";
        return answer(svc, ctx, { kind: "query", question: str(args, "question"), mode, depth: num(args, "depth", 3), tokenBudget: num(args, "token_budget", svc.cfg.defaultTokenBudget), contextFilter: strs(args, "context_filter") });
      },
    },
    {
      name: "codegraph_node",
      description: "Details of one symbol or file in the Code Graph: definition location, kind, community, degree. Ambiguous names return the candidate list — pick one and call again with its exact id.",
      parameters: { type: "object", properties: { name: NAME }, required: ["name"] },
      async run(args, ctx) { return answer(svc, ctx, { kind: "node", name: str(args, "name") }); },
    },
    {
      name: "codegraph_neighbors",
      description: "Direct connections of one symbol: who imports/calls/inherits it and what it calls, each with path:line and EXTRACTED/INFERRED. Use before changing a signature.",
      parameters: {
        type: "object",
        properties: { name: NAME, relation: { type: "string", description: "Optional relation filter: calls, imports, imports_from, inherits, implements, method, references, contains." }, token_budget: { type: "number", description: "200-8000 (default 2000)." } },
        required: ["name"],
      },
      async run(args, ctx) { return answer(svc, ctx, { kind: "neighbors", name: str(args, "name"), relation: str(args, "relation") || undefined, tokenBudget: num(args, "token_budget", svc.cfg.defaultTokenBudget) }); },
    },
    {
      name: "codegraph_path",
      description: "Shortest dependency path between two symbols/files (follows edge direction unless undirected=true). Use to explain how one part of the code reaches another.",
      parameters: {
        type: "object",
        properties: { from: NAME, to: NAME, max_hops: { type: "number", description: "1-12 (default 8)." }, undirected: { type: "boolean", description: "Ignore edge direction (default false)." } },
        required: ["from", "to"],
      },
      async run(args, ctx) { return answer(svc, ctx, { kind: "path", from: str(args, "from"), to: str(args, "to"), maxHops: num(args, "max_hops", 8), undirected: bool(args, "undirected", false) }); },
    },
    {
      name: "codegraph_affected",
      description: "Reverse blast radius: every caller/importer/subclass that depends on a symbol, up to N hops, with path:line. Run before refactors, renames and deletions, then confirm the call sites with file_read.",
      parameters: {
        type: "object",
        properties: { name: NAME, depth: { type: "number", description: "1-4 (default 2)." }, relations: { type: "array", items: { type: "string" }, description: "Optional relations to traverse, e.g. [\"calls\",\"imports\"]." } },
        required: ["name"],
      },
      async run(args, ctx) { return answer(svc, ctx, { kind: "affected", name: str(args, "name"), depth: num(args, "depth", 2), relations: strs(args, "relations") }); },
    },
    {
      name: "codegraph_hubs",
      description: "The most-connected symbols (architectural hubs) of the project. Good first call to orient in an unfamiliar codebase. Hubs include test and i18n helpers (e.g. t(), str()); skip those when describing architecture.",
      parameters: { type: "object", properties: { top_n: { type: "number", description: "1-50 (default 10)." } } },
      async run(args, ctx) { return answer(svc, ctx, { kind: "hubs", topN: num(args, "top_n", 10) }); },
    },
    {
      name: "codegraph_community",
      description: "List the members of one detected subsystem (community id from codegraph_node/neighbors output). Community ids change between rebuilds — never store them.",
      parameters: { type: "object", properties: { id: { type: "number", description: "Community id." }, token_budget: { type: "number", description: "200-8000 (default 2000)." } }, required: ["id"] },
      async run(args, ctx) { return answer(svc, ctx, { kind: "community", id: num(args, "id", 0), tokenBudget: num(args, "token_budget", svc.cfg.defaultTokenBudget) }); },
    },
  ];
}
