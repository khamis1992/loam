import type { Config } from "../config.js";
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
  let lastError: unknown = null;
  for (let i = 0; i < models.length; i++) {
    const model = models[i]!;
    try {
      return await opts.ollama.chat({
        model,
        messages: opts.messages,
        ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
        temperature: opts.temperature ?? opts.cfg.agent.temperature,
        timeoutMs: opts.timeoutMs ?? opts.cfg.agent.requestTimeoutMs,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onToken ? { onToken: opts.onToken } : {}),
      });
    } catch (err) {
      // User cancellation must NEVER fall through the model fallback chain — it stops the run now.
      if (opts.signal?.aborted || isCancelledError(err)) throw new CancelledError();
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`model ${model} failed: ${msg}`);
      const next = models[i + 1];
      if (next) opts.notify?.(`model ${model} failed (${msg}); trying fallback ${next}`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
