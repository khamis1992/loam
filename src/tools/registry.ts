import type { Config } from "../config.js";
import type { Emit } from "../agent/events.js";
import type { OllamaFunctionTool } from "../ollama.js";
import { runLifecycleHooks } from "../policy/hooks.js";
import { getLoamMode } from "../modes/catalog.js";

export interface ToolContext {
  cfg: Config;
  workspace: string;
  emit: Emit;
  signal?: AbortSignal;
  /** Active task id, so long-running tools can poll for cancellation. */
  taskId?: string;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  /** Optional base64 images (no data: prefix) to attach to the next model call (vision). */
  images?: string[];
}

export interface Tool {
  /** Explicit external integration, available only after a task-specific grant. */
  integration?: boolean;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

function truncate(s: string, max = 16000): string {
  return s.length > max ? `${s.slice(0, max)}\n[...truncated ${s.length - max} chars]` : s;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readOnly = false;

  /** Each task receives an immutable capability subset. Hooks cannot bypass it.
   *  `extraAllow` carries gateway-granted tools beyond the mode set (e.g. computer
   *  use under the user-device work mode); they are still vetted by the caller. */
  forMode(modeId: string, extraAllow: string[] = []): ToolRegistry {
    const mode = getLoamMode(modeId);
    const allow = extraAllow.length > 0 ? [...new Set([...mode.tools, ...extraAllow])] : mode.tools;
    const sub = this.cloneFiltered({ allow });
    sub.readOnly = true;
    return sub;
  }

  /** Explicit allowlist: unknown/MCP/browser/shell tools cannot execute in Ask mode. */
  forAskMode(): ToolRegistry {
    return this.forMode("ask");
  }

  /** Gateway-scoped subset: forMode semantics (immutable, hook-free) for an
   *  arbitrary allowlist — the companion gateway's resolved tool set. */
  forAllowlist(allow: string[]): ToolRegistry {
    const sub = this.cloneFiltered({ allow });
    sub.readOnly = true;
    return sub;
  }

  /** Copy of this registry plus extra tool instances bound at run start
   *  (companion device tools); readOnly semantics are preserved. */
  withTools(extra: Tool[]): ToolRegistry {
    const sub = this.cloneFiltered({});
    // Extras are bound AFTER allowlist resolution; the CALLER pre-filters them
    // against the same capability allowlist (index.ts does) so a revoked
    // device/memory/team tool never reaches this point.
    for (const t of extra) sub.register(t);
    return sub;
  }

  /** Replace an existing tool in place (approval wrapping at run start). */
  replaceTool(tool: Tool): void {
    if (!this.tools.has(tool.name)) throw new Error(`unknown tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: Tool[]): void {
    for (const t of tools) this.register(t);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** Return a new ToolRegistry containing a filtered subset of tools (used by subagents). */
  cloneFiltered(opts: { allow?: string[]; deny?: string[] } = {}): ToolRegistry {
    const sub = new ToolRegistry();
    sub.readOnly = this.readOnly;
    const allowSet = opts.allow !== undefined ? new Set(opts.allow) : null;
    const denySet = new Set(opts.deny ?? []);
    for (const [name, tool] of this.tools) {
      if (denySet.has(name)) continue;
      if (allowSet && !allowSet.has(name)) continue;
      sub.register(tool);
    }
    return sub;
  }

  toOllama(): OllamaFunctionTool[] {
    return [...this.tools.values()].map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  async exec(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, content: `unknown tool "${name}". Available tools: ${this.names().join(", ")}` };
    }
    try {
      const pre = this.readOnly ? { blocked: false, message: "" } : await runLifecycleHooks("PreToolUse", name, args, ctx.workspace);
      if (pre.blocked) {
        return { ok: false, content: truncate(pre.message) };
      }
      const result = await tool.run(args, ctx);
      const post = this.readOnly ? { message: "" } : await runLifecycleHooks("PostToolUse", name, args, ctx.workspace);
      const combined = [pre.message, result.content, post.message].filter((s) => s && s.trim().length > 0).join("\n\n");
      return {
        ok: result.ok,
        content: truncate(combined),
        ...(result.images && result.images.length > 0 ? { images: result.images } : {}),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, content: `tool "${name}" failed: ${msg}` };
    }
  }
}

export function str(args: Record<string, unknown>, key: string, def = ""): string {
  const v = args[key];
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return def;
  return String(v);
}

export function num(args: Record<string, unknown>, key: string, def: number): number {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return def;
}

export function bool(args: Record<string, unknown>, key: string, def = false): boolean {
  const v = args[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "true";
  return def;
}
