import { OllamaClient } from "../../ollama.js";
import type { LegalModelPort } from "./types.js";
import { isApprovedLocal, type EgressConfig } from "../egress.js";

export interface LegalModelPortOptions {
  config: EgressConfig;
  client?: Pick<OllamaClient, "chat">;
}

export function createLegalModelPort(opts: LegalModelPortOptions): { port: LegalModelPort; client: Pick<OllamaClient, "chat"> } {
  if (!isApprovedLocal(opts.config.localModel, opts.config)) throw new Error("legal local model is not approved or Ollama is not loopback");
  const client = opts.client ?? new OllamaClient(opts.config.ollamaUrl);
  const port: LegalModelPort = async (req) => {
    if (!isApprovedLocal(req.model, opts.config)) throw new Error(`legal model call blocked: ${req.model}`);
    const result = await client.chat({
      model: req.model,
      messages: req.messages,
      temperature: req.temperature,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      format: req.format,
    });
    if (!isApprovedLocal(result.model, opts.config)) throw new Error(`legal provider returned an unapproved model: ${result.model}`);
    return result;
  };
  return { port, client };
}
