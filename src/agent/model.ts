import type { Config } from "../config.js";
import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatResult, OllamaClient, OllamaFunctionTool } from "../ollama.js";
import { log } from "../log.js";
import { CancelledError, isCancelledError } from "../server/runControl.js";

export interface ModelCallOptions {
  cfg: Config;
  ollama: OllamaClient;
  messages: ChatMessage[];
  tools?: OllamaFunctionTool[];
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onToken?: (text: string) => void;
  /** Preferred model; "" or undefined = cfg.model. Falls back to cfg.model then cfg.fallbackModel. */
  model?: string;
  /** Called before each fallback attempt (never for the last candidate). */
  notify?: (message: string) => void;
  /** Enable thinking mode for local models (default: false for Ollama). */
  think?: boolean;
}

export function candidateModels(cfg: Config, preferred?: string): string[] {
  const first = preferred && preferred.trim().length > 0 ? preferred.trim() : cfg.model;
  const out: string[] = [];
  for (const m of [first, cfg.model, cfg.fallbackModel]) {
    if (m && m.trim().length > 0 && !out.includes(m)) out.push(m);
  }
  return out;
}

/** One model call with the configured fallback chain (preferred -> main -> fallback). */
export async function chatWithFallback(opts: ModelCallOptions): Promise<ChatResult> {
  const models = candidateModels(opts.cfg, opts.model);
  const requestId = randomUUID();
  let lastError: unknown = null;
  for (let i = 0; i < models.length; i++) {
    const model = models[i]!;
    const started = performance.now();
    const attempt = { requestId, attempt: i + 1, model };
    // Diagnostic metadata only: never prompts, responses, arguments or credentials.
    log.info("model_request", { ...attempt, phase: "start", messageCount: opts.messages.length, toolCount: opts.tools?.length ?? 0, timeoutMs: opts.timeoutMs ?? opts.cfg.agent.requestTimeoutMs });
    try {
      const result = await opts.ollama.chat({
        model,
        messages: opts.messages,
        ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
        temperature: opts.temperature ?? opts.cfg.agent.temperature,
        timeoutMs: opts.timeoutMs ?? opts.cfg.agent.requestTimeoutMs,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onToken ? { onToken: opts.onToken } : {}),
        think: opts.think ?? false,
      });
      
      // If thinking mode returned empty content due to length limit, retry without thinking
      if (opts.think === true && result.content.trim().length === 0 && result.doneReason === "length") {
        log.info("model_request", { ...attempt, phase: "retry_no_think", reason: "empty_content_with_length" });
        const retryResult = await opts.ollama.chat({
          model,
          messages: opts.messages,
          ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
          temperature: opts.temperature ?? opts.cfg.agent.temperature,
          timeoutMs: opts.timeoutMs ?? opts.cfg.agent.requestTimeoutMs,
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.onToken ? { onToken: opts.onToken } : {}),
          think: false,
        });
        log.info("model_request", { ...attempt, phase: "complete", elapsedMs: Math.round(performance.now() - started), providerDurationMs: retryResult.usage.durationMs, promptTokens: retryResult.usage.promptTokens, completionTokens: retryResult.usage.completionTokens, toolCallCount: retryResult.toolCalls.length });
        return retryResult;
      }
      
      log.info("model_request", { ...attempt, phase: "complete", elapsedMs: Math.round(performance.now() - started), providerDurationMs: result.usage.durationMs, promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens, toolCallCount: result.toolCalls.length });
      return result;
    } catch (err) {
      // User cancellation must NEVER fall through the model fallback chain — it stops the run now.
      const cancelled = opts.signal?.aborted || isCancelledError(err);
      log.info("model_request", { ...attempt, phase: cancelled ? "cancelled" : "failed", elapsedMs: Math.round(performance.now() - started) });
      if (cancelled) throw new CancelledError();
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`model ${model} failed: ${msg}`);
      const next = models[i + 1];
      if (next) opts.notify?.(`model ${model} failed (${msg}); trying fallback ${next}`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
