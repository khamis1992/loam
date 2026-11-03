import type { ChatResult } from "../../ollama.js";
import type { ModelPort, ModelRequest } from "../modelPort.js";
import type { Config } from "../../config.js";
import { ORCHESTRATION_DEFAULTS } from "../config.js";

/** Scripted model: returns the queued replies in order and records requests. */
export function scriptedPort(replies: string[]): ModelPort & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  const port = (async (req: ModelRequest): Promise<ChatResult> => {
    calls.push(req);
    const content = replies.shift();
    if (content === undefined) throw new Error("scriptedPort: no reply left");
    return { content, toolCalls: [], model: req.model, usage: { promptTokens: 100, completionTokens: 20, durationMs: 5 } };
  }) as ModelPort & { calls: ModelRequest[] };
  port.calls = calls;
  return port;
}

/**
 * Loam-shaped test config. Loam's Config is large; tests build the minimal
 * surface the Core reads (model routing for cloud-only checks + orchestration)
 * and cast, exactly like the repo's existing test fixtures.
 */
export function testConfig(): Config {
  return {
    model: "qwen3:8b",
    agent: { requestTimeoutMs: 60_000, temperature: 0.2 },
    orchestrator: { plannerModel: "gpt-oss:120b:cloud", verifierModel: "", maxReplans: 1 },
    orchestration: structuredClone(ORCHESTRATION_DEFAULTS),
    failover: {
      providers: [
        { id: "local", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b", apiKeyEnv: "", enabled: true },
        { id: "lan", kind: "openai-compatible", baseUrl: "http://localhost:8080/v1", model: "lan-model", apiKeyEnv: "", enabled: true },
        { id: "remote", kind: "openai-compatible", baseUrl: "https://api.example.com/v1", model: "remote-model", apiKeyEnv: "X_KEY", enabled: true },
      ],
    },
  } as unknown as Config;
}
