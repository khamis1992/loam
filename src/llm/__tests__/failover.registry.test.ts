import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ProviderHttpError, type ChatResult } from "../../ollama.js";
import { chatWithFailover, createProviderClient, hasUsableKey, type CooldownStore, type FailoverProvider } from "../failover.js";
import type { CompiledProvider } from "../../models/registry/compile.js";
import type { ModelRecord, ProviderRecord } from "../../models/registry/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function memoryStore(): CooldownStore {
  const map = new Map<string, { expiresAt: number; backoffCount: number }>();
  return {
    get: (key) => map.get(key),
    set: (key, entry) => { map.set(key, entry); },
    entries: () => [...map.entries()],
    save: () => undefined,
  };
}

function provider(auth: ProviderRecord["auth"]): CompiledProvider {
  const record: ProviderRecord = {
    id: "gateway",
    label: "بوابة",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:9/v1",
    location: "cloud",
    auth,
    extraHeaders: {},
    timeoutMs: 1000,
    enabled: true,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
  const model: ModelRecord = {
    id: "gateway/gpt",
    providerId: "gateway",
    remoteId: "gpt",
    label: "GPT",
    capabilities: { tools: "unknown", vision: "unknown", thinking: "unknown", jsonMode: "unknown", contextWindow: null, maxOutputTokens: null, source: "user" },
    defaults: {},
    enabled: true,
    tags: [],
  };
  return {
    id: model.id,
    kind: record.kind,
    baseUrl: record.baseUrl,
    model: model.remoteId,
    apiKeyEnv: "",
    enabled: true,
    registryModelId: model.id,
    providerRef: record,
    modelRef: model,
  };
}

function answer(text: string): ChatResult {
  return { content: text, toolCalls: [], model: "gpt", usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
}

describe("registry failover", () => {
  it("keeps a vault-backed provider in the chain and sends its key", async () => {
    const compiled = provider({ type: "bearer", credentialId: "11111111-1111-4111-8111-111111111111" });
    assert.equal(hasUsableKey(compiled), true);
    let auth = "";
    let sentModel = "";
    globalThis.fetch = (async (_url, init) => {
      auth = new Headers(init?.headers).get("authorization") ?? "";
      sentModel = JSON.parse(String(init?.body)).model;
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "تم" } }] })}\n\ndata: [DONE]\n`,
        { status: 200 },
      );
    }) as typeof fetch;
    const client = createProviderClient(compiled, {}, "sk-vault");
    const result = await client.chat({ model: "ignored", messages: [{ role: "user", content: "هلا" }] });
    assert.equal(auth, "Bearer sk-vault");
    assert.equal(sentModel, "gpt");
    assert.equal(result.content, "تم");
  });

  it("answers from the second provider when the first returns 503", async () => {
    const first: FailoverProvider = { id: "a", kind: "ollama", baseUrl: "http://127.0.0.1:9", model: "one", apiKeyEnv: "", enabled: true };
    const second: FailoverProvider = { id: "b", kind: "ollama", baseUrl: "http://127.0.0.1:9", model: "two", apiKeyEnv: "", enabled: true };
    const tried: string[] = [];
    const result = await chatWithFailover({
      providers: [first, second],
      chat: { messages: [{ role: "user", content: "hi" }] },
      store: memoryStore(),
      createClient: (p) => ({
        chat: async () => {
          tried.push(p.id);
          if (p.id === "a") throw new ProviderHttpError("down", 503, new Headers());
          return answer("from-b");
        },
      }),
    });
    assert.deepEqual(tried, ["a", "b"]);
    assert.equal(result.content, "from-b");
  });
});
