/**
 * The Core facade: built once per run in src/index.ts next to
 * runOrchestratedAgent and passed down through OrchestratorOptions.core.
 * Owns model choice (cloud only), the traced model port and the tracer.
 * No second runtime: it only wraps Loam's own calls.
 */
import type { Config } from "../config.js";
import type { OllamaClient } from "../ollama.js";
import { chatWithFallback } from "../agent/model.js";
import { after } from "../protocol/eventLog.js";
import { isCloudModel, pickCloudModel, NoCloudModelError } from "../llm/cloudModel.js";
import { ORCHESTRATION_DEFAULTS, clampOrchestration, type OrchestrationConfig } from "./config.js";
import type { ModelPort } from "./modelPort.js";
import { Tracer, type Span, type SpanContext } from "./tracing/tracer.js";
import { GENAI, SPAN } from "./tracing/genai.js";
import type { CheckpointPayloadReader } from "./durable/checkpoints.js";

export type CoreRole = "ledger" | "selection" | "judge";

export interface OrchestrationCore {
  cfg: OrchestrationConfig;
  tracer: Tracer;
  /** Root span of the run; children use runSpan.context as parent. */
  runSpan: Span;
  port: ModelPort;
  /** Cloud model for a role, or undefined (feature degrades, never falls back to local). */
  modelFor(role: CoreRole): string | undefined;
  readCheckpoint: CheckpointPayloadReader;
  /** W3C header for child processes (ACP agents, sandboxed tools). */
  traceparentEnv(parent?: SpanContext): Record<string, string>;
}

export function loamModelPort(cfg: Config, ollama: OllamaClient, tracer: Tracer, parent: () => SpanContext | undefined, taskId: string): ModelPort {
  return async (req) =>
    tracer.withSpan(SPAN.modelCall, { parent: parent(), kind: "client", taskId, attributes: { [GENAI.operation]: "chat", [GENAI.requestModel]: req.model } }, async (span) => {
      const res = await chatWithFallback({ cfg, ollama, messages: req.messages, model: req.model, temperature: req.temperature, timeoutMs: req.timeoutMs, signal: req.signal });
      span.setAttributes({
        [GENAI.responseModel]: res.model,
        [GENAI.inputTokens]: res.usage.promptTokens,
        [GENAI.outputTokens]: res.usage.completionTokens,
      });
      span.recordContent("output", res.content);
      // A fallback chain may land on a non-cloud model; Core roles must not accept that.
      if (!isCloudModel(cfg, res.model)) throw new NoCloudModelError(`core call (${req.model} fell back to ${res.model})`);
      return res;
    });
}

export function createOrchestrationCore(cfg: Config, ollama: OllamaClient, taskId: string, sessionId: string, inboundTraceparent?: string): OrchestrationCore {
  const oc = clampOrchestration(cfg.orchestration ?? structuredClone(ORCHESTRATION_DEFAULTS));
  const tracer = new Tracer({ enabled: oc.tracing.enabled, sampleRate: oc.tracing.sampleRate, captureContent: oc.tracing.captureContent, maxSpansPerTrace: oc.tracing.maxSpansPerTrace });
  const runSpan = tracer.startSpan(SPAN.run, { parent: inboundTraceparent, taskId, sessionId, attributes: { [GENAI.conversationId]: sessionId } });
  const pick = (feature: string, first: string): string | undefined => {
    try {
      return pickCloudModel(cfg, feature, [first, cfg.orchestrator?.plannerModel ?? "", cfg.model]);
    } catch {
      return undefined;
    }
  };
  return {
    cfg: oc,
    tracer,
    runSpan,
    port: loamModelPort(cfg, ollama, tracer, () => runSpan.context, taskId),
    modelFor: (role) => (role === "ledger" ? pick("progress ledger", oc.ledger.model) : role === "selection" ? pick("candidate selection", oc.selection.model) : pick("trajectory judge", oc.evals.judgeModel)),
    readCheckpoint: (s, seq) => after(s, seq - 1, 1)[0]?.payload,
    traceparentEnv: (parent) => {
      const c = parent ?? runSpan.context;
      return { TRACEPARENT: `00-${c.traceId}-${c.spanId}-${c.sampled ? "01" : "00"}` };
    },
  };
}
