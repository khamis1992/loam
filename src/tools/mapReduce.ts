import type { OllamaClient } from "../ollama.js";
import { runAgent } from "../agent/loop.js";
import type { Tool, ToolContext, ToolResult, ToolRegistry } from "./registry.js";
import { num, str } from "./registry.js";

const DEFAULT_MAP_REDUCE_TOOLS = [
  "file_read",
  "file_list",
  "file_search",
  "file_stat",
  "web_search",
  "web_fetch",
  "file_write",
  "file_edit",
  "shell_run",
];

const MAX_CONCURRENCY = 20;
const MAX_ITEMS = 500;
const MIN_ITEMS = 2;

interface SubResult {
  index: number;
  item: string;
  ok: boolean;
  content: string;
  subSessionId: string;
  steps: number;
  toolCalls: number;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Shared bounded-concurrency fan-out used by map_reduce and the workflow runner.
 * Workers pull the next index in order and stop when `signal` aborts, so a
 * cancelled run never starts new work. A worker may return `null` to signal
 * "skipped" (e.g. aborted before starting); nulls are dropped from the result.
 */
export async function runBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R | null>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      if (signal?.aborted) break;
      const i = cursor++;
      const value = await worker(items[i]!, i);
      if (value !== null) results.push(value);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface MapReduceOptions {
  ollama: OllamaClient;
  parentRegistry: ToolRegistry;
  /** Optional subagent profile name to use for each child. */
  defaultSubagent?: string;
  /** Tool allowlist for child runs. */
  childAllowTools?: string[];
  /** Max steps per child. */
  maxSteps?: number;
}

export function createMapReduceTool(options: MapReduceOptions): Tool {
  const { ollama, parentRegistry, defaultSubagent = "coder", childAllowTools = DEFAULT_MAP_REDUCE_TOOLS, maxSteps = 12 } = options;
  return {
    name: "map_reduce",
    description:
      "Run the same instruction over many items in parallel child agents and collect the results. Each child runs in isolation with a fresh context.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["instruction", "items"],
      properties: {
        instruction: {
          type: "string",
          description: "Task instruction applied to each item. Use {item} to refer to the current item.",
        },
        items: {
          type: "array",
          minItems: MIN_ITEMS,
          maxItems: MAX_ITEMS,
          items: { type: "string", minLength: 1 },
          description: "List of items to process (2–500).",
        },
        outputSchema: {
          type: "object",
          description: "Optional JSON Schema each child result should conform to.",
        },
        concurrency: {
          type: "integer",
          minimum: 1,
          maximum: MAX_CONCURRENCY,
          default: MAX_CONCURRENCY,
          description: "Maximum parallel child agents (1–20).",
        },
        subagent: {
          type: "string",
          description: "Subagent profile name for children (default: coder).",
        },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const instructionTemplate = str(args, "instruction").trim();
      const items = Array.isArray(args.items) ? args.items.filter((i): i is string => typeof i === "string" && i.length > 0) : [];
      if (!instructionTemplate) return { ok: false, content: "map_reduce requires an instruction" };
      if (items.length < MIN_ITEMS) return { ok: false, content: `map_reduce requires at least ${MIN_ITEMS} items` };
      if (items.length > MAX_ITEMS) return { ok: false, content: `map_reduce supports at most ${MAX_ITEMS} items` };

      const concurrency = clamp(num(args, "concurrency", MAX_CONCURRENCY), 1, MAX_CONCURRENCY);
      const childRegistry = parentRegistry.forAllowlist(childAllowTools);
      const subagentName = str(args, "subagent", defaultSubagent).trim();

      ctx.emit({ type: "tool_call", name: "map_reduce", args: { count: items.length, concurrency, subagent: subagentName } });

      const runChild = async (i: number, item: string): Promise<SubResult> => {
        const subSessionId = `mapreduce-${ctx.taskId ?? "anon"}-${i}`;
        const prompt = instructionTemplate.replace(/\{item\}/g, item);
        let toolCalls = 0;
        try {
          ctx.emit({
            type: "tool_call",
            name: "mapReduceSubSessionStatus",
            args: { subSessionId, index: i, status: "started", item },
          });
          const res = await runAgent({
            cfg: ctx.cfg,
            ollama,
            tools: childRegistry,
            emit: (ev) => {
              if (ev.type === "tool_call") toolCalls += 1;
              ctx.emit(ev);
            },
            prompt,
            systemSuffix: `[Subagent: ${subagentName}]\nYou are a focused subagent running one item of a parallel map-reduce job. Produce a concise, evidence-grounded result. Do not delegate further subagents.`,
            maxSteps,
            signal: ctx.signal,
            taskId: ctx.taskId,
            suppressFinal: true,
          });
          ctx.emit({
            type: "tool_result",
            name: "mapReduceSubSessionStatus",
            ok: true,
            summary: `subagent ${subSessionId} finished`,
          });
          return { index: i, item, ok: true, content: res.text, subSessionId, steps: res.steps, toolCalls };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.emit({
            type: "tool_result",
            name: "mapReduceSubSessionStatus",
            ok: false,
            summary: `subagent ${subSessionId} failed: ${msg}`,
          });
          return { index: i, item, ok: false, content: msg, subSessionId, steps: 0, toolCalls };
        }
      };

      // Fan-out with bounded concurrency; results are re-sorted by item index so
      // the output order is deterministic regardless of completion order.
      const results = (
        await runBounded(items, concurrency, (item, i) => runChild(i, item), ctx.signal)
      ).sort((a, b) => a.index - b.index);

      const outputSchema = args.outputSchema as Record<string, unknown> | undefined;
      const parsed = results.map((r) => {
        if (!outputSchema || !r.ok) return r;
        try {
          // Try to parse each child result as JSON; if it fails, keep raw text.
          const parsedContent = JSON.parse(r.content);
          return { ...r, parsedContent };
        } catch {
          return r;
        }
      });

      return {
        ok: results.every((r) => r.ok),
        content: JSON.stringify({ count: items.length, completed: results.length, results: parsed }, null, 2),
      };
    },
  };
}
