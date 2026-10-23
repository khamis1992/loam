/**
 * Codemode — sandboxed JavaScript that chains harness tools in one turn.
 *
 * Adapted from jcode (MIT) ref/codemode/lib.rs and ref/codemode/engine.rs.
 * jcode's engine used `rquickjs` (async runtime); Loam runs on Node, so the
 * same design is rebuilt on `quickjs-emscripten`'s synchronous runtime. The
 * host bridge is synchronous from QuickJS's point of view: a host function
 * returns a QuickJS promise that settles when the underlying tool call
 * finishes, and the runtime's pending-job queue is pumped from the Node event
 * loop. That keeps `Promise.all` over many tool calls genuinely concurrent,
 * which the asyncify variant cannot do (it cannot suspend twice).
 *
 * The sandbox runs where Loam runs, not where `shell_run` runs: it has no
 * filesystem, network, timer, or process API. The only way to affect the
 * outside world is through `tools.<name>(args)`, routed by the caller through
 * Loam's normal tool registry and approval/policy path.
 */

import type { JSPromiseState, QuickJSContext, QuickJSDeferredPromise, QuickJSHandle, QuickJSWASMModule, VmFunctionImplementation } from "quickjs-emscripten-core";
import { createQuickJSModule } from "./wasmLoader.js";

/** A tool the script may call through `tools.<name>(args)`. */
export interface CodemodeToolInfo {
  name: string;
  description: string;
  /** JSON schema of the tool arguments (exposed via `describeTool`). */
  parameters?: Record<string, unknown>;
}

/** Resource limits for one run. Defaults mirror jcode's `Limits::default`. */
export interface CodemodeLimits {
  /** QuickJS heap limit in bytes. */
  memoryBytes: number;
  /** Wall-clock limit for the whole script, including awaited tool calls. */
  timeoutMs: number;
  /** Maximum tool calls per run. */
  maxToolCalls: number;
  /** Maximum bytes of captured `console.*` output. */
  maxLogBytes: number;
  /** Maximum size of one tool result handed to the script (bytes, UTF-8). */
  maxToolResultBytes: number;
  /** Maximum length of the serialized return value. */
  maxResultBytes: number;
}

export const DEFAULT_CODEMODE_LIMITS: CodemodeLimits = {
  memoryBytes: 64 * 1024 * 1024,
  timeoutMs: 300_000,
  maxToolCalls: 2_000,
  maxLogBytes: 64 * 1024,
  maxToolResultBytes: 16 * 1024,
  maxResultBytes: 16 * 1024,
};

/** Interpreter jobs executed per pump step before the loop is yielded back.
 *  Capping the batch keeps the deadline timer and abort listeners responsive
 *  while a script is busy. */
const JOB_BATCH = 64;

/**
 * Host side of the sandbox. Returning `ok: false` throws an `Error` inside the
 * script, so a policy denial is indistinguishable from a tool failure there.
 */
export interface CodemodeHost {
  callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown; error?: string }>;
  /** Aborts in-flight tool calls when the run is torn down. */
  signal?: AbortSignal;
}

/** Result of one run. */
export interface CodemodeRunOutput {
  /** JSON value the script returned (`undefined` when it returned nothing). */
  result: unknown | undefined;
  /** Error message if the script threw, timed out, or was cancelled. */
  error: string | undefined;
  /** Captured `console.*` lines. */
  logs: string[];
  /** Whether log capture hit `maxLogBytes`. */
  logsTruncated: boolean;
  /** Number of tool calls the script made. */
  toolCalls: number;
  /** Session store after the run (persisted by the caller between runs). */
  store: Record<string, unknown>;
  /** Wall-clock duration of the run in milliseconds. */
  elapsedMs: number;
  /** Serialized form of the result, already capped to `maxResultBytes`. */
  text: string;
}

/** Decode a tool's text output into the most useful script value: parsed JSON
 *  when the output is a JSON object or array, otherwise the raw string. */
export function decodeToolOutput(text: string): unknown {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return text;
    }
  }
  return text;
}

function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

// ----------------------------------------------------------------------------
// Prelude
// ----------------------------------------------------------------------------

/**
 * Everything the script gets beyond QuickJS's default intrinsics. Mirrors
 * jcode's `PRELUDE` so ported scripts behave identically.
 */
const PRELUDE = `(() => {
  const fmt = (v) => {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.stack ? v.name + ": " + v.message + "\\n" + v.stack : v.name + ": " + v.message;
    try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch (_) { return String(v); }
  };
  const log = (level) => (...args) => __log(level, args.map(fmt).join(" "));
  globalThis.console = { log: log("log"), info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") };

  const call = async (name, args) => {
    const raw = await __callTool(String(name), JSON.stringify(args === undefined ? {} : args));
    const r = JSON.parse(raw);
    if (!r.ok) throw new Error(name + ": " + r.error);
    return r.value;
  };
  globalThis.callTool = call;
  // Discovery helpers are installed before the proxy so the traps below can
  // reuse them: __listTools() crosses the bridge as a JSON *string*.
  globalThis.listTools = (filter) => {
    const all = JSON.parse(__listTools());
    if (!filter) return all;
    const f = String(filter).toLowerCase();
    return all.filter((t) => t.name.toLowerCase().includes(f) || t.description.toLowerCase().includes(f));
  };
  globalThis.describeTool = (name) => {
    const raw = __describeTool(String(name));
    return raw === "" ? undefined : JSON.parse(raw);
  };

  globalThis.tools = new Proxy({}, {
    get(_, name) {
      if (typeof name !== "string" || name === "then") return undefined;
      return (args) => call(name, args);
    },
    // Membership must agree with the tool list, or the in operator would
    // advertise a tool the host then refuses (and vice versa).
    has(_, name) { return typeof name === "string" && listTools().some((t) => t.name === name); },
    ownKeys() { return listTools().map((t) => t.name); },
    getOwnPropertyDescriptor(_, name) {
      return typeof name === "string" && listTools().some((t) => t.name === name)
        ? { enumerable: true, configurable: true }
        : undefined;
    },
  });
  globalThis.store = (key, value) => { __storeSet(String(key), JSON.stringify(value === undefined ? null : value)); return value; };
  globalThis.load = (key) => { const raw = __storeGet(String(key)); return raw === "" ? undefined : JSON.parse(raw); };
  globalThis.storedKeys = () => JSON.parse(__storeKeys());
})();
`;

// ----------------------------------------------------------------------------
// Engine
// ----------------------------------------------------------------------------

let modulePromise: Promise<QuickJSWASMModule> | undefined;

/** Lazily load the shared QuickJS WASM module (one per process). */
export function loadQuickJS(): Promise<QuickJSWASMModule> {
  modulePromise ??= createQuickJSModule();
  return modulePromise;
}

export async function runCodemode(input: {
  code: string;
  host: CodemodeHost;
  tools: CodemodeToolInfo[];
  store?: Record<string, unknown>;
  limits?: Partial<CodemodeLimits>;
}): Promise<CodemodeRunOutput> {
  const limits = { ...DEFAULT_CODEMODE_LIMITS, ...(input.limits ?? {}) };
  const store: Record<string, unknown> = { ...(input.store ?? {}) };
  const startedAt = Date.now();
  const deadline = startedAt + limits.timeoutMs;

  const logs: string[] = [];
  let logBytes = 0;
  let logsTruncated = false;
  let toolCalls = 0;

  const QuickJS = await loadQuickJS();
  const runtime = QuickJS.newRuntime();
  const pending = new Set<QuickJSDeferredPromise>();
  let finished = false;
  let error: string | undefined;
  let result: unknown | undefined;
  // Set when the run signal aborted while the interpreter was still busy. The
  // poller may exit on the deadline first, so the flag carries the cancellation
  // out instead of letting it be reported as a timeout.
  let aborted = false;
  /** Latch the cancellation as soon as the signal fires, so the run cannot be
   *  reported as a timeout even if the poller exits on the deadline first. */
  const onAbort = (): void => {
    aborted = true;
    error = "cancelled";
    // A busy script can starve the polling loop, so the run must wake up the
    // moment it is cancelled instead of waiting for its next turn.
    if (!finished) {
      finished = true;
      finishPolling?.();
    }
  };
  if (input.host.signal) {
    if (input.host.signal.aborted) onAbort();
    else input.host.signal.addEventListener("abort", onAbort, { once: true });
  }
  // Abort handle for tool calls still in flight at teardown.
  let abortController: AbortController | undefined;
  // Resolved with the run promise when the interpreter is done (see the poller).
  let finishPolling: (() => void) | undefined;

  try {
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(1024 * 1024);
    runtime.setInterruptHandler(() => Date.now() >= deadline || input.host.signal?.aborted === true);

    const ctx = runtime.newContext();

    const pushLog = (level: string, line: string): void => {
      if (logsTruncated) return;
      const text = level === "log" || level === "info" ? line : `[${level}] ${line}`;
      if (logBytes + text.length + 1 > limits.maxLogBytes) {
        logsTruncated = true;
        return;
      }
      logBytes += text.length + 1;
      logs.push(text);
    };

    /** Yield to the Node event loop once per pump step. Without it a busy
     *  script keeps the interpreter inside `executePendingJobs` and the process
     *  never runs the timer that enforces the deadline or an abort listener. */
    const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    /** Drain the interpreter's job queue from the Node event loop. Each batch is
     *  capped and followed by a yield, so the deadline timer and any abort
     *  listener always get a turn even when the script is busy. */
    const pump = async (): Promise<void> => {
      if (finished) return;
      const step = async (): Promise<void> => {
        if (finished) return;
        try {
          if (runtime.hasPendingJob()) runtime.executePendingJobs(JOB_BATCH);
        } catch {
          /* interrupted: the deadline handler is checked by the poller */
        }
        if (!finished) await yieldToLoop().then(step);
      };
      await step();
    };

    const install = (name: string, fn: VmFunctionImplementation<QuickJSHandle>): void => {
      const handle = ctx.newFunction(name, fn);
      ctx.setProp(ctx.global, name, handle);
      handle.dispose();
    };

    install("__log", (level: QuickJSHandle, line: QuickJSHandle) => {
      pushLog(ctx.getString(level), ctx.getString(line));
      return ctx.undefined;
    });

    install("__listTools", () =>
      ctx.newString(
        JSON.stringify(input.tools.map((t) => ({ name: t.name, description: firstLine(t.description) }))),
      ),
    );

    install("__describeTool", (name: QuickJSHandle) => {
      const tool = input.tools.find((t) => t.name === ctx.getString(name));
      if (!tool) return ctx.newString("");
      return ctx.newString(
        JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.parameters ?? { type: "object" } }),
      );
    });

    install("__storeSet", (key: QuickJSHandle, raw: QuickJSHandle) => {
      let value: unknown = null;
      try {
        value = JSON.parse(ctx.getString(raw));
      } catch {
        value = null;
      }
      store[ctx.getString(key)] = value;
      return ctx.undefined;
    });

    install("__storeGet", (key: QuickJSHandle) => {
      const value = store[ctx.getString(key)];
      return ctx.newString(value === undefined ? "" : JSON.stringify(value));
    });

    install("__storeKeys", () => ctx.newString(JSON.stringify(Object.keys(store))));

    /**
     * Settle a deferred promise with a tool envelope. The promise handle is
     * owned by QuickJS once the host function returns it, so only the deferred's
     * resolvers are released here (resolve() does that); the handle itself is
     * freed with the context.
     */
    const settle = (deferred: QuickJSDeferredPromise, text: string): void => {
      deferred.resolve(ctx.newString(text));
      pending.delete(deferred);
      pump();
    };

    const callTool = (name: QuickJSHandle, rawArgs: QuickJSHandle): QuickJSHandle => {
      const toolName = ctx.getString(name);
      if (input.host.signal?.aborted === true) return alreadySettled("cancelled");
      if (!input.tools.some((t) => t.name === toolName)) {
        const lower = toolName.toLowerCase();
        const similar = input.tools
          .map((t) => t.name)
          .filter((n) => n.toLowerCase().includes(lower) || lower.includes(n.toLowerCase()))
          .slice(0, 5);
        const hint = similar.length > 0 ? ` Did you mean: ${similar.join(", ")}?` : "";
        return alreadySettled(`unknown tool '${toolName}'.${hint} Use listTools() to see available tools.`);
      }
      toolCalls += 1;
      if (toolCalls > limits.maxToolCalls) {
        return alreadySettled(`tool call limit reached (${limits.maxToolCalls} per run)`);
      }
      let args: Record<string, unknown>;
      try {
        const parsed = JSON.parse(ctx.getString(rawArgs)) as unknown;
        args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      } catch {
        return alreadySettled("arguments are not JSON");
      }
      const deferred = ctx.newPromise();
      pending.add(deferred);
      abortController ??= new AbortController();
      void input.host
        .callTool(toolName, args)
        .then((outcome) => {
          if (finished) return;
          const value = typeof outcome.value === "string" ? decodeToolOutput(outcome.value) : outcome.value;
          const encoded = outcome.ok ? { ok: true, value } : { ok: false, error: outcome.error ?? "tool failed" };
          // Cap the payload before encoding so the envelope stays valid JSON.
          let text = JSON.stringify(encoded);
          if (text.length > limits.maxToolResultBytes) {
            const raw = JSON.stringify(value);
            const kept = raw.slice(0, limits.maxToolResultBytes);
            text = JSON.stringify(outcome.ok ? { ok: true, value: kept } : { ok: false, error: kept });
          }
          settle(deferred, text);
        })
        .catch((err: unknown) => {
          if (finished) return;
          settle(deferred, JSON.stringify({ ok: false, error: String(err) }));
        });
      return deferred.handle;
    };

    install("__callTool", callTool);

    /** A failure the host can answer synchronously (unknown tool, limit, ...). */
    const alreadySettled = (message: string): QuickJSHandle => {
      const deferred = ctx.newPromise();
      pending.add(deferred);
      queueMicrotask(() => {
        if (finished) return;
        settle(deferred, JSON.stringify({ ok: false, error: message }));
      });
      return deferred.handle;
    };

    // Install the prelude: console, tools, listTools, describeTool, store, load.
    const preludeResult = ctx.evalCode(PRELUDE);
    if (preludeResult.error) {
      const detail = ctx.dump(preludeResult.error);
      error = runError(`prelude failed: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`, input.host.signal, limits);
      preludeResult.error.dispose();
    } else {
      preludeResult.value.dispose();
    }

    let outer: QuickJSHandle | undefined;
    if (!error) {
      const evalResult = ctx.evalCode(`(async () => {\n${input.code}\n})()`);
      if (evalResult.error) {
        const detail = ctx.dump(evalResult.error);
        error = runError(typeof detail === "string" ? detail : JSON.stringify(detail), input.host.signal, limits);
        evalResult.error.dispose();
      } else {
        outer = evalResult.value;
      }
    }

    if (outer) {
      // Pump jobs until the script's promise settles, the deadline passes, or
      // the run is cancelled. The interpreter is touched from one task only.
      await new Promise<void>((resolve) => {
        void pump();
        finishPolling = resolve;
        const check = (): void => {
          if (finished) return resolve();
          let state: JSPromiseState;
          try {
            state = ctx.getPromiseState(outer!);
          } catch {
            finished = true;
            error = "codemode runtime error";
            return resolve();
          }
          if (state.type === "pending") {
            if (Date.now() >= deadline) {
              finished = true;
              // A cancellation wins over the deadline: the same interrupt
              // handler covers both, so report whichever happened.
              error = aborted ? "cancelled" : `timed out after ${Math.round(limits.timeoutMs / 1000)}s`;
              return resolve();
            }
            if (aborted) {
              finished = true;
              error = "cancelled";
              return resolve();
            }
            setTimeout(check, 2);
            return;
          }
          finished = true;
          try {
            if (state.type === "fulfilled") {
              const value = state.value;
              if (value && value.alive) {
                result = ctx.dump(value);
                value.dispose();
              }
            } else {
              const detail = state.error && state.error.alive ? ctx.dump(state.error) : "unknown error";
              // The interrupt handler fires for BOTH the deadline and an
              // aborted run signal, so an abort must be told apart from a
              // timeout: report cancellation, never "timed out".
              error = runError(typeof detail === "string" ? detail : JSON.stringify(detail), input.host.signal, limits);
              if (state.error && state.error.alive) state.error.dispose();
            }
          } catch (err) {
            error = `codemode runtime error: ${String(err)}`;
          }
          resolve();
        };
        check();
      });
    }

    outer?.dispose();
    ctx.dispose();
  } catch (err) {
    if (!error) error = aborted ? "cancelled" : `codemode failed: ${String(err)}`;
  } finally {
    finished = true;
    input.host.signal?.removeEventListener("abort", onAbort);
    // An aborted run never reads as a timeout, whatever the exit path was.
    if (aborted) error = "cancelled";
    // Reject every call still in flight so the tool implementation stops, and
    // stop any timers it may have set (jcode aborts its spawned host tasks).
    abortController?.abort();
    pending.clear();
    try {
      runtime.dispose();
    } catch {
      /* a leaked handle can make the WASM runtime abort on free; ignore */
    }
  }

  return {
    result,
    error,
    logs,
    logsTruncated,
    toolCalls,
    store,
    elapsedMs: Date.now() - startedAt,
    text: truncateResult(result, error, limits.maxResultBytes),
  };
}

/** The error text for a failed run: a cancellation is never reported as a
 *  timeout, because the same interrupt handler covers both. */
function runError(raw: string, signal: AbortSignal | undefined, limits: CodemodeLimits): string {
  if (signal?.aborted === true) return "cancelled";
  return formatJsError(raw, limits);
}

function formatJsError(raw: string, limits: CodemodeLimits): string {
  const trimmed = raw.trim();
  if (trimmed.includes("out of memory")) return `${trimmed} (memory limit reached)`;
  if (trimmed.includes("interrupted")) return `timed out after ${Math.round(limits.timeoutMs / 1000)}s`;
  return trimmed;
}

/** Serialize the script's return value for the transcript, capped to `maxBytes`. */
export function truncateResult(result: unknown | undefined, error: string | undefined, maxBytes: number): string {
  if (error) return error.length > maxBytes ? `${error.slice(0, maxBytes)}\n[...truncated]` : error;
  if (result === undefined) return "";
  let text: string;
  try {
    text = JSON.stringify(result) ?? "";
  } catch {
    text = String(result);
  }
  return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n[...truncated ${text.length - maxBytes} chars]` : text;
}
