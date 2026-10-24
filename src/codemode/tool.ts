/**
 * Codemode agent tool.
 *
 * Adapted from jcode (MIT) ref/codemode/lib.rs (the `codemode` tool surface).
 *
 * `codemode` runs a short model-written JavaScript program in a sandbox and
 * returns only what the script returns. The script reaches the outside world
 * exclusively through `tools.<name>(args)`; every one of those calls goes
 * through this tool's host, which runs the call on the run's own tool registry
 * under the same approval and policy path as a normal tool call. A policy
 * denial becomes an ordinary tool failure inside the script, never a bypass.
 *
 * The feature is opt-in: `codemode` is off by default and only becomes callable
 * when the Settings › Data controls toggle (or the config default) enables it.
 */
import fs from "node:fs";
import path from "node:path";
import { getSettings } from "../server/settings.js";
import { DATA_DIR, loadConfig } from "../config.js";
import { createCodemodeGate, type CodemodeGateInput } from "./policyGate.js";
import { DEFAULT_CODEMODE_LIMITS, runCodemode, type CodemodeHost, type CodemodeRunOutput, type CodemodeToolInfo } from "./engine.js";
import type { Emit } from "../agent/events.js";
import type { Tool, ToolContext, ToolResult } from "../tools/registry.js";
import { str } from "../tools/registry.js";

export const CODEMODE_TOOL = "codemode";

/** Hard cap on the script source, so one call cannot blow up the request. */
export const CODEMODE_MAX_CODE_CHARS = 60_000;

/** Every codemode run resolves these settings once. */
export interface CodemodeSettings {
  enabled: boolean;
  timeoutMs: number;
  memoryBytes: number;
  maxToolCalls: number;
}

/**
 * Codemode is opt-in. The stored preference (Settings › Data controls) wins over
 * the config default, and a missing value keeps the conservative default: off.
 */
export function resolveCodemodeSettings(): CodemodeSettings {
  const configured = loadConfig().codemode ?? { enabled: false, timeoutMs: 0, memoryBytes: 0, maxToolCalls: 0 };
  const preferred = getSettings().codemode;
  const enabled = typeof preferred === "boolean" ? preferred : configured.enabled;
  return {
    enabled,
    timeoutMs: numberOr(configured.timeoutMs, DEFAULT_CODEMODE_LIMITS.timeoutMs),
    memoryBytes: numberOr(configured.memoryBytes, DEFAULT_CODEMODE_LIMITS.memoryBytes),
    maxToolCalls: numberOr(configured.maxToolCalls, DEFAULT_CODEMODE_LIMITS.maxToolCalls),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** The registry surface codemode needs: it only ever calls tools already granted
 *  to this run, so a script can never reach a tool the model could not call. */
export interface CodemodeRegistry {
  names(): string[];
  get(name: string): Tool | undefined;
  exec(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Render a run for the transcript: only the script's return value, its logs and
 *  the call/error summary. Intermediate tool output never enters here. */
export function formatCodemodeResult(out: CodemodeRunOutput): string {
  if (out.error) return `codemode failed: ${out.error}`;
  const lines: string[] = [];
  if (out.logs.length > 0) {
    lines.push(`console (${out.logs.length} line${out.logs.length === 1 ? "" : "s"}):`, ...out.logs.map((line) => `  ${line}`));
  }
  lines.push(`tool calls: ${out.toolCalls}`);
  if (out.text.length > 0) lines.push(out.text);
  return lines.join("\n");
}

export interface CodemodeToolOptions {
  /** The run's allowlisted registry; scripts can only reach these tools. */
  registry: CodemodeRegistry;
  taskId?: string;
  agentId?: string | null;
  workspaceRoot?: string;
  emit?: Emit;
  signal?: AbortSignal;
  /** Resolved sandbox mode for this run (see `resolveSandboxPolicy`). */
  sandboxMode?: import("../policy/riskTier.js").SandboxMode;
}

/**
 * Register `codemode` in the global registry so the gateway/allowlist
 * intersection can reach it. The instance refuses: a script must run against
 * the *run's* allowlisted registry, and `index.ts` replaces this stub with a
 * per-run instance bound to it before any execution.
 */
export function createUnboundCodemodeTool(): Tool {
  return {
    name: CODEMODE_TOOL,
    description: "Codemode sandbox (not bound to a run)",
    parameters: { type: "object", additionalProperties: false, required: ["code"], properties: { code: { type: "string" } } },
    async run(): Promise<ToolResult> {
      return { ok: false, content: "codemode is only available inside a run (not bound to a tool registry)" };
    },
  };
}

/**
 * Build the codemode tool bound to one run's registry, task and policy state.
 * The returned tool is registered in the global registry, but its `run` refuses
 * unless the opt-in setting is on, so it is inert until the user enables it.
 */
export function createCodemodeTool(options: CodemodeToolOptions): Tool {
  const { registry } = options;

  return {
    name: CODEMODE_TOOL,
    description:
      "Run a short JavaScript program in a sandbox that can call this session's tools through tools.<name>(args) " +
      "and callTool(name, args). Use it to run a fan-out of tool calls in one turn (for example read and grep many " +
      "files in parallel, or retry a search several ways) and return a compact summary, so the intermediate results " +
      "stay inside the script instead of filling the transcript. " +
      "Inside the script: tools.<name>(args) and callTool(name, args) both return the tool result and throw on " +
      "failure; listTools(filter?), describeTool(name) and 'name' in tools discover what is callable; " +
      "store(key, value) / load(key) / storedKeys() persist a small JSON value across runs in this task; " +
      "console.log(...) output is captured and shown, not returned. " +
      "The script has no filesystem, network, timer or process access, and it is limited by CPU time, memory and a " +
      "cap on the number of tool calls. Only what the script returns (or its error) reaches the transcript.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["code"],
      properties: {
        code: {
          type: "string",
          maxLength: CODEMODE_MAX_CODE_CHARS,
          description:
            "JavaScript body of an async function. `await tools.<name>(args)` calls a tool and returns its result; " +
            "a tool failure throws. `return` sets the value the agent sees (JSON-serializable, objects and arrays included).",
        },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const settings = resolveCodemodeSettings();
      if (!settings.enabled) {
        return {
          ok: false,
          content:
            "codemode is disabled. It is opt-in: enable it in Settings › Data controls (Codemode sandbox), then call this tool again.",
        };
      }
      const code = str(args, "code").trim();
      if (!code) return { ok: false, content: "codemode requires a non-empty code argument" };
      if (code.length > CODEMODE_MAX_CODE_CHARS) {
        return { ok: false, content: `codemode code exceeds the ${CODEMODE_MAX_CODE_CHARS} character limit` };
      }

      // The script may not reach codemode itself: nesting sandboxes would let a
      // script start unbounded child runtimes (jcode excludes the tool too).
      const tools: CodemodeToolInfo[] = registry
        .names()
        .filter((name) => name !== CODEMODE_TOOL)
        .map((name) => registry.get(name))
        .filter((tool): tool is Tool => tool !== undefined)
        .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));

      const gateInput: CodemodeGateInput = {
        taskId: options.taskId ?? ctx.taskId ?? "",
        agentId: options.agentId ?? ctx.agentId ?? null,
        workspaceRoot: options.workspaceRoot ?? ctx.workspace,
        sandboxMode: options.sandboxMode ?? loadConfig().policy.sandboxMode,
        emit: options.emit ?? ctx.emit,
        signal: options.signal ?? ctx.signal,
      };
      const gate = createCodemodeGate(gateInput);

      const host: CodemodeHost = {
        signal: gateInput.signal,
        async callTool(name, callArgs) {
          if (name === CODEMODE_TOOL) return { ok: false, error: "codemode cannot call itself" };
          const tool = registry.get(name);
          if (!tool) return { ok: false, error: `unknown tool '${name}'` };
          // The policy gate is the first decision point: a denied call never
          // reaches the registry, so it cannot have a side effect.
          const refusal = await gate.authorize(name, callArgs);
          if (refusal) return { ok: false, error: refusal };
          const result = await registry.exec(name, callArgs, {
            ...ctx,
            taskId: gateInput.taskId,
            agentId: gateInput.agentId ?? undefined,
          });
          return result.ok ? { ok: true, value: result.content } : { ok: false, error: result.content };
        },
      };

      const store = loadStore(gateInput.taskId);
      const output = await runCodemode({
        code,
        host,
        tools,
        store,
        limits: {
          timeoutMs: settings.timeoutMs,
          memoryBytes: settings.memoryBytes,
          maxToolCalls: settings.maxToolCalls,
        },
      });
      saveStore(gateInput.taskId, output.store);
      return { ok: true, content: formatCodemodeResult(output) };
    },
  };
}

// --- session store persistence -------------------------------------------------
// The sandbox store persists across runs of the same task, like jcode's session
// map. Values are small JSON blobs under Loam's data dir, never in the repo.

/** Directory holding one store file per task (created on first write). */
export const CODEMODE_STORE_DIR = path.join(DATA_DIR, "codemode-store");

function sanitize(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "anonymous";
}

/** Path of the store file for a task (exported for tests and diagnostics). */
export function codemodeStoreFile(taskId: string): string {
  return path.join(CODEMODE_STORE_DIR, `${sanitize(taskId)}.json`);
}

/** Read a task's store from disk; a missing or corrupt file is an empty store. */
export function loadStore(taskId: string): Record<string, unknown> {
  try {
    const file = codemodeStoreFile(taskId);
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Persist a task's store. Failures are non-fatal: the run already succeeded. */
export function saveStore(taskId: string, store: Record<string, unknown>): void {
  try {
    fs.mkdirSync(CODEMODE_STORE_DIR, { recursive: true });
    const file = codemodeStoreFile(taskId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1), "utf8");
    fs.renameSync(tmp, file);
  } catch {
    /* ignore: the sandbox result is still returned to the model */
  }
}
