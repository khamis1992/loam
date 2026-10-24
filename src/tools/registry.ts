import type { Config } from "../config.js";
import type { Emit } from "../agent/events.js";
import type { OllamaClient, OllamaFunctionTool } from "../ollama.js";
import { runLifecycleHooks } from "../policy/hooks.js";
import { getLoamMode } from "../modes/catalog.js";
import { getToolProfile } from "../agent/taskToolScope.js";
import type { ReadState } from "./readState.js";
import type { PrunedStore } from "../agent/prune/prunedStore.js";

export interface ToolContext {
  cfg: Config;
  workspace: string;
  emit: Emit;
  signal?: AbortSignal;
  /** Provider client for tools that talk to the model layer themselves (M3
   *  MiroFish swarm runs). Optional so unit tests and read-only/script
   *  contexts can construct a context without one. */
  ollama?: OllamaClient;
  /** Active task id, so long-running tools can poll for cancellation. */
  taskId?: string;
  /** Owning companion agent id (vault/memory scope). Optional: tools fall back
   *  to a neutral scope when the run context does not carry one. */
  agentId?: string;
  /** Tool names the current run is allowed to use. Tools that fan out to
   *  child agents use it so a child can never exceed the parent run's
   *  capabilities. Undefined means "no run scope known". */
  allowedTools?: readonly string[];
  /** Current subagent delegation depth (0 = top-level). Used by delegate_task. */
  depth?: number;
  /** Per-session read tracking. Edit/write tools reject unread or stale
   *  existing files while it is present. */
  readState?: ReadState;
  /** Bodies the context pruner dropped from the transcript this run, so
   *  `context_recall` can hand one back by id. Absent when pruning is off. */
  prunedStore?: PrunedStore;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  /** Optional base64 images (no data: prefix) to attach to the next model call (vision). */
  images?: string[];
  /**
   * N3 Knowledge Garden: seed ids this tool call produced or retrieved. The run
   * graph reads it to hang `kb_seed` nodes off the step that used them, so the
   * citation trail on the canvas is derived from real tool output rather than
   * parsed back out of prose. Ignored by every tool that does not set it.
   */
  kbSeedIds?: string[];
  /** Human-readable shape of those seeds, so the canvas can render the nodes
   *  without the graph layer reaching into the knowledge store. */
  kbSeeds?: Array<{ id: string; title: string; tags: string[]; preview: string }>;
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

  /** Named tool-profile subset (e.g. "coding"): an immutable, hook-free view
   *  exposing only the tools that profile declares. Unknown profiles throw. */
  forProfile(profileId: string): ToolRegistry {
    const profile = getToolProfile(profileId);
    if (!profile) throw new Error(`Unknown tool profile: ${profileId}`);
    return this.forAllowlist(profile.tools);
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

  /**
   * Bind extra run-scoped instances, *replacing* an already-present tool of the
   * same name.
   *
   * Some tools are registered process-wide for discovery (e.g. `recall`) but
   * need a per-run binding (the run id and the callback that files a hit into
   * that run). Adding such an instance with `withTools` would collide, because
   * `register` rejects a duplicate name, so this replaces it instead. The name
   * is already in the caller's allowlist, so reachability is unchanged.
   */
  withBound(extra: Tool[]): ToolRegistry {
    const sub = this.cloneFiltered({});
    for (const t of extra) {
      if (sub.get(t.name)) sub.replaceTool(t);
      else sub.register(t);
    }
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

  all(): Tool[] {
    return [...this.tools.values()];
  }

  isRegistered(name: string): boolean {
    return this.tools.has(name);
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
        ...(result.kbSeedIds && result.kbSeedIds.length > 0 ? { kbSeedIds: result.kbSeedIds } : {}),
        ...(result.kbSeeds && result.kbSeeds.length > 0 ? { kbSeeds: result.kbSeeds } : {}),
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

export function strs(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === "string");
}

/**
 * Return the first present string among `keys`, in order. Used to accept two
 * spellings of the same argument (for example the canonical `old_string` and
 * its legacy alias `find`) without coercing a legitimately empty string to a
 * default. Returns undefined when no key holds a string.
 */
export function strFirst(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}
