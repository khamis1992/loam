import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { OllamaClient } from "../ollama.js";
import type { Emit } from "../agent/events.js";
import { runAgent } from "../agent/loop.js";
import type { ToolRegistry } from "../tools/registry.js";
import type {
  SubagentEvent,
  SubagentProvider,
  SubagentResult,
  SubagentRunHandle,
  SubagentStartOptions,
} from "./types.js";
import { EventQueue } from "./eventQueue.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_STEPS = 20;

/** Stateless in-process provider. Runtime dependencies (config, Ollama client,
 *  and the already-scoped toolset) arrive with each start() call, so a single
 *  registered instance serves every run. */
export function createInProcessProvider(): SubagentProvider {
  return {
    name: "in-process",
    async start(opts: SubagentStartOptions): Promise<SubagentRunHandle> {
      if (!opts.cfg || !opts.ollama || !opts.tools) {
        throw new Error("in-process provider requires cfg, ollama, and tools");
      }
      return startInProcess({ cfg: opts.cfg, ollama: opts.ollama, tools: opts.tools }, opts);
    },
  };
}

function startInProcess(deps: { cfg: Config; ollama: OllamaClient; tools: ToolRegistry }, opts: SubagentStartOptions): SubagentRunHandle {
  const id = randomUUID();
  const events = new EventQueue<SubagentEvent>();
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let settled = false;
  let resultResolve!: (value: SubagentResult) => void;
  const resultPromise = new Promise<SubagentResult>((resolve) => {
    resultResolve = resolve;
  });

  const timer = setTimeout(() => {
    if (settled) return;
    controller.abort();
    finish("timeout", `Subagent timed out after ${timeoutMs}ms`);
  }, timeoutMs);
  timer.unref?.();

  function finish(stopReason: SubagentResult["stopReason"], text: string): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    events.close();
    resultResolve({ stopReason, text });
  }

  const emit: Emit = (event) => {
    if (event.type === "tool_call") events.push({ type: "tool_call", name: event.name });
    else if (event.type === "assistant_message") events.push({ type: "text", text: event.text });
    else if (event.type === "assistant_token") events.push({ type: "text", text: event.text });
    else if (event.type === "error") events.push({ type: "error", message: event.message });
  };

  const effectiveCfg = opts.model ? { ...deps.cfg, model: opts.model } : deps.cfg;
  const runDepth = opts.depth ?? 0;

  runAgent({
    cfg: effectiveCfg,
    ollama: deps.ollama,
    tools: deps.tools,
    emit,
    prompt: opts.prompt,
    signal: controller.signal,
    maxSteps: opts.maxSteps ?? DEFAULT_MAX_STEPS,
    suppressFinal: true,
    ...(runDepth > 0 ? { depth: runDepth } : {}),
  })
    .then((res) => {
      finish("completed", res.text);
    })
    .catch(() => {
      if (settled) return;
      finish(controller.signal.aborted ? "cancelled" : "error", "");
    });

  return {
    id,
    events,
    result: () => resultPromise,
    cancel() {
      if (settled) return;
      controller.abort();
      finish("cancelled", "");
    },
  };
}
