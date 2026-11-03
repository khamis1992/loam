import type { Config } from "../../config.js";
import type { OllamaClient, ChatMessage } from "../../ollama.js";
import { chatWithFallback } from "../../agent/model.js";
import { callStructured } from "../../orchestration/contracts/structured.js";
import type { JsonSchema } from "../../orchestration/contracts/schema.js";
import type { ModelPort } from "../../orchestration/modelPort.js";
import { OfficeIntelligenceError } from "./contracts.js";

export interface OfficeModelResult<T> {
  value: T;
  usage: { promptTokens: number; completionTokens: number };
}

export interface OfficeModelGateway {
  readonly model: string;
  generate<T>(input: {
    contract: string;
    schema: JsonSchema;
    messages: ChatMessage[];
    signal?: AbortSignal;
  }): Promise<OfficeModelResult<T>>;
}

export function createOfficeModelGateway(cfg: Config, ollama: OllamaClient, model = cfg.model): OfficeModelGateway {
  const port: ModelPort = async (req) => chatWithFallback({
    cfg,
    ollama,
    model: req.model,
    messages: req.messages,
    temperature: req.temperature,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
  });
  return {
    model,
    async generate<T>(input: { contract: string; schema: JsonSchema; messages: ChatMessage[]; signal?: AbortSignal }): Promise<OfficeModelResult<T>> {
      if (!model.trim()) throw new OfficeIntelligenceError("no Office intelligence model is configured", 503, "model_unavailable");
      const result = await callStructured<T>(port, {
        model,
        contract: input.contract,
        schema: input.schema,
        messages: input.messages,
        repairAttempts: 1,
        temperature: 0,
        timeoutMs: 120_000,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!result.ok) {
        throw new OfficeIntelligenceError("the model returned output that did not satisfy the required contract", 422, "model_output_invalid");
      }
      return {
        value: result.value,
        usage: { promptTokens: result.promptTokens, completionTokens: result.completionTokens },
      };
    },
  };
}
