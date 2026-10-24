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
import { isFail } from "quickjs-emscripten-core";
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
  /** Error raised inside a pending job (e.g. an out-of-memory allocation). */
  let pumpError: string | undefined;
  /** True while the drain loop is scheduled, so re-entrant calls are ignored. */
  let pumpScheduled = false;
  /** Set when the runtime is out of memory and can no longer be touched safely. */
  let poisoned = false;
  /** Set once the run has a definite outcome (limit, cancellation, or job error).
   *  The wrapper promise can then only settle with `undefined`, so a settled
   *  promise after this is never reported as a success. */
  let decided = false;
  /** Latch the cancellation as soon as the signal fires, so the run cannot be
   *  reported as a timeout even if the poller exits on the deadline first. */
  const onAbort = (): void => {
    aborted = true;
    error = "cancelled";
    decided = true;
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
  /** Scheduled at the deadline, so a script that never yields still wakes up. */
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  /** Re-arms the poller's pending-promise check; set by the poller below. */
  let scheduleCheck: () => void = () => {};

  try {
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(1024 * 1024);
    runtime.setInterruptHandler(() => Date.now() >= deadline || input.host.signal?.aborted === true);

    /** Wake the poller and the parked pump at the deadline. The QuickJS interrupt
     *  handler above only runs while the interpreter executes, so this timer is
     *  what lets a script that never yields still be reported. The poller is
     *  re-scheduled (not finished) so the deadline is read on the same path as a
     *  still-pending run; finishing here would report an unsettled run as a
     *  success. */
    const scheduleDeadline = (): void => {
      if (finished || deadlineTimer) return;
      deadlineTimer = setTimeout(() => {
        deadlineTimer = undefined;
        wakePump();
        scheduleCheck();
      }, Math.max(1, deadline - Date.now()));
    };

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

    /** Drain the interpreter's job queue from the Node event loop until the run
     *  ends. Each batch is capped and followed by a yield, so the deadline timer
     *  and any abort listener always get a turn even when the script is busy. When
     *  the queue is empty the pump parks until the deadline timer fires or a tool
     *  result wakes it, so an awaited loop that never settles still runs until its
     *  deadline. */
    let pumpResume: (() => void) | undefined;
    const pump = (): void => {
      if (finished || pumpScheduled || poisoned) return;
      pumpScheduled = true;
      const step = (): void => {
        pumpScheduled = false;
        if (finished) return;
        try {
          if (runtime.hasPendingJob()) {
            const result = runtime.executePendingJobs(JOB_BATCH);
            // An out-of-memory or interrupted job must not be swallowed: an
            // awaited allocation loop trips the heap cap inside a pending job, and
            // the error only surfaces here (the outer promise stays pending).
            if (isFail(result)) {
              const failed = result.error;
              const detail = failed.context.dump(failed);
              pumpError ??= typeof detail === "string" ? detail : JSON.stringify(detail);
              if (failed.alive) failed.dispose();
              // Stop draining and report the captured error: the outer promise
              // is still pending, so the poller must not wait for the deadline.
              if (!finished) {
                finished = true;
                decided = true;
                error = formatJsError(pumpError, limits);
                finishPolling?.();
              }
              // The runtime may have freed the job queue while out of memory:
              // probing it again can abort the process (see the teardown guard).
              poisoned = true;
              return;
            }
            // More work: keep draining, one loop turn per batch.
            pumpScheduled = true;
            void yieldToLoop().then(step);
            return;
          }
          // No work: report a job error captured by a previous step, then park
          // until the deadline timer fires or a tool result wakes the pump. The
          // poller still enforces the deadline.
          if (pumpError && !finished) {
            finished = true;
            decided = true;
            error = formatJsError(pumpError, limits);
            return;
          }
          pumpResume = () => pump();
        } catch {
          /* interrupted: the deadline handler is checked by the poller */
        }
      };
      void step();
    };

    /** Wake a parked pump (a tool result queued a job). No-op if it is already
     *  draining, the runtime is out of memory, or the run is over. */
    const wakePump = (): void => {
      if (finished || pumpScheduled || poisoned) return;
      const resume = pumpResume;
      pumpResume = undefined;
      if (resume) pump();
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
      if (poisoned) {
        // The runtime is out of memory; resolving the deferred can abort the
        // process, so answer from the host side instead.
        pending.delete(deferred);
        return;
      }
      deferred.resolve(ctx.newString(text));
      pending.delete(deferred);
      wakePump();
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
      // The wrapper defers the script's promise so a job that rejects (an
      // out-of-memory allocation inside an awaited loop) is reported through the
      // outer promise instead of surfacing as a lost unhandled rejection. The
      // host never settles it; the runtime frees it on teardown.
      const evalResult = ctx.evalCode(
        `globalThis.__codemode_resolve = null;\n` +
          `globalThis.__codemode_reject = null;\n` +
          `new Promise((__resolve, __reject) => {\n` +
          `  globalThis.__codemode_resolve = __resolve;\n` +
          `  globalThis.__codemode_reject = __reject;\n` +
          `  (async () => {\n${input.code}\n})().then(\n` +
          `    (__v) => __resolve(__v),\n` +
          `    (__e) => __reject(__e),\n` +
          `  );\n` +
          `})`,
      );
      if (evalResult.error) {
        const detail = ctx.dump(evalResult.error);
        error = runError(typeof detail === "string" ? detail : JSON.stringify(detail), input.host.signal, limits);
        evalResult.error.dispose();
      } else {
        outer = evalResult.value;
      }
    }

    /** Drop the script's promise handle so the runtime can be freed. The wrapper
     *  promise may still be pending (a script that never settles, or one stopped by
     *  its limit); QuickJS frees it with the runtime, and resolving it here instead
     *  queues a job that outlives the drain and trips the `JS_FreeRuntime`
     *  object-list assertion. */
    const releaseOuter = (): void => {
      if (!outer) return;
      const handle = outer;
      outer = undefined;
      try {
        handle.dispose();
      } catch {
        /* ignore */
      }
    };

    if (outer) {
      // Drain jobs until the script's promise settles, the deadline passes, or
      // the run is cancelled. The interpreter is touched from one task only.
      void pump();
      scheduleDeadline();
      await new Promise<void>((resolve) => {
        finishPolling = resolve;
        const check = (): void => {
          if (finished) return resolve();
          // A job error captured by the pump (out-of-memory inside an awaited
          // loop) wins over the deadline: it must never read as a timeout.
          if (pumpError && !error) error = formatJsError(pumpError, limits);
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
              decided = true;
              // A cancellation wins over the deadline: the same interrupt
              // handler covers both, so report whichever happened.
              error = aborted ? "cancelled" : `timed out after ${Math.round(limits.timeoutMs / 1000)}s`;
              return resolve();
            }
            if (aborted) {
              finished = true;
              decided = true;
              error = "cancelled";
              return resolve();
            }
            // Keep polling: a tool result settles the script asynchronously, so
            // the pump needs a turn and the poller needs to re-check the promise.
            // The deadline timer below is the backstop for a script that never
            // yields (a sync busy loop starves this poll).
            if (!poisoned && runtime.hasPendingJob()) wakePump();
            scheduleCheck = () => setTimeout(check, 2);
            scheduleCheck();
            return;
          }
          finished = true;
          try {
            if (state.type === "fulfilled") {
              const value = state.value;
              // The wrapper resolves the outer promise as soon as the script's
              // own promise settles, which can be `undefined` for a script that
              // never returns (an infinite awaited loop stopped by the interrupt).
              // A run that already hit a limit must keep reporting it, and a
              // fulfilled `undefined` is only a real result when the script
              // returned nothing at all — otherwise it is the wrapper artifact.
              if (value && value.alive) {
                result = ctx.dump(value);
                value.dispose();
              }
              if (decided && error === undefined) {
                error = `timed out after ${Math.round(limits.timeoutMs / 1000)}s`;
              }
            } else if (decided) {
              // The wrapper was released by the host, so its `undefined`
              // resolution is an artifact of teardown, not a run outcome.
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

    releaseOuter();
    ctx.dispose();
  } catch (err) {
    if (!error) error = aborted ? "cancelled" : `codemode failed: ${String(err)}`;
  } finally {
    finished = true;
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }
    input.host.signal?.removeEventListener("abort", onAbort);
    // A job error captured by the pump (out-of-memory inside an awaited loop)
    // must survive even if the run ended on the deadline first.
    if (pumpError && !error) error = formatJsError(pumpError, limits);
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

  return buildOutput(result, error, limits, logs, logsTruncated, toolCalls, store, startedAt);
}

/** Assemble the run output, capping the text payload. */
function buildOutput(
  result: unknown,
  error: string | undefined,
  limits: CodemodeLimits,
  logs: string[],
  logsTruncated: boolean,
  toolCalls: number,
  store: Record<string, unknown>,
  startedAt: number,
): CodemodeRunOutput {
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
