import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ProviderHttpError } from "../../../ollama.js";
import { AnthropicAdapter } from "../anthropic.js";
import { classifyError, createProviderError } from "../errors.js";
import { GeminiAdapter } from "../gemini.js";
import { OllamaAdapter } from "../ollama.js";
import { OpenAICompatAdapter } from "../openaiCompat.js";
import type { AdapterOptions } from "../types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function sse(body: string, status = 200, headers?: Record<string, string>): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status, headers });
}

function options(extra: Partial<AdapterOptions> = {}): AdapterOptions {
  return { baseUrl: "http://127.0.0.1:9", timeoutMs: 1000, ...extra };
}

describe("adapter errors", () => {
  it("classifies a timeout and a rate limit with Retry-After", () => {
    assert.equal(classifyError(new Error("request timed out")).code, "timeout");
    const limited = classifyError(new Error("no"), new Response("", { status: 429, headers: { "retry-after": "12" } }));
    assert.equal(limited.code, "rate_limited");
    assert.equal(limited.retryAfterSec, 12);
    const billed = createProviderError(401, { error: { message: "bad key" } });
    assert.equal(billed.code, "auth");
    assert.equal(billed.message, "bad key");
  });
});

describe("openai-compatible adapter", () => {
  it("reads text, reasoning, and a tool call without leaving the machine", async () => {
    let auth = "";
    globalThis.fetch = (async (_url, init) => {
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return sse(
        [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" } }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "think" } }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "lookup", arguments: "{\"q\":\"a\"}" } }] } }] })}`,
          `data: ${JSON.stringify({ choices: [{ finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 4 } })}`,
          "data: [DONE]",
          "",
        ].join("\n"),
      );
    }) as typeof fetch;

    const adapter = new OpenAICompatAdapter(options({ apiKey: "sk-test" }));
    const result = await adapter.chat({
      model: "gpt-test",
      messages: [{ role: "user", content: "go" }],
    });
    assert.equal(auth, "Bearer sk-test");
    assert.equal(result.content, "Hi");
    assert.equal(result.thinking, "think");
    assert.equal(result.toolCalls[0]?.function.name, "lookup");
    assert.deepEqual(result.toolCalls[0]?.function.arguments, { q: "a" });
    assert.equal(result.usage.promptTokens, 3);
  });

  it("turns a 401 into an auth error", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })) as typeof fetch;
    const adapter = new OpenAICompatAdapter(options({ apiKey: "sk-test" }));
    await assert.rejects(
      () => adapter.chat({ model: "gpt-test", messages: [{ role: "user", content: "go" }] }),
      (err: unknown) => err instanceof ProviderHttpError && err.status === 401 && err.message === "bad key",
    );
  });
});

describe("anthropic adapter", () => {
  it("sends the system text separately and the key on x-api-key", async () => {
    let sent: { headers: Headers; body: { system?: string; messages: Array<{ role: string }> } } | undefined;
    globalThis.fetch = (async (_url, init) => {
      sent = { headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return sse(
        [
          `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "مرحبًا" } })}`,
          `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}`,
          "",
        ].join("\n"),
      );
    }) as typeof fetch;

    const adapter = new AnthropicAdapter(options({ apiKey: "ant-test", baseUrl: "http://127.0.0.1:9/v1" }));
    const result = await adapter.chat({
      model: "claude-test",
      messages: [
        { role: "system", content: "كن موجزًا" },
        { role: "user", content: "هلا" },
      ],
    });
    assert.equal(sent?.headers.get("x-api-key"), "ant-test");
    assert.equal(sent?.headers.get("anthropic-version"), "2023-06-01");
    assert.equal(sent?.body.system, "كن موجزًا");
    assert.equal(sent?.body.messages.some((row) => row.role === "system"), false);
    assert.equal(result.content, "مرحبًا");
    assert.equal(result.doneReason, "end_turn");
  });
});

describe("gemini adapter", () => {
  it("strips the models prefix and reads a function call", async () => {
    let called = "";
    let key = "";
    globalThis.fetch = (async (url, init) => {
      called = String(url);
      key = new Headers(init?.headers).get("x-goog-api-key") ?? "";
      return sse(
        `data: ${JSON.stringify({
          candidates: [{
            content: { parts: [{ functionCall: { name: "search", args: { q: "node" } } }] },
            finishReason: "STOP",
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
        })}\n`,
      );
    }) as typeof fetch;

    const adapter = new GeminiAdapter(options({ apiKey: "gem-test", baseUrl: "http://127.0.0.1:9/v1beta" }));
    const result = await adapter.chat({
      model: "models/gemini-test",
      messages: [{ role: "user", content: "ابحث" }],
    });
    assert.equal(called.includes("/models/gemini-test:streamGenerateContent"), true);
    assert.equal(called.includes("/models/models/"), false);
    assert.equal(key, "gem-test");
    assert.equal(result.toolCalls[0]?.function.name, "search");
    assert.deepEqual(result.toolCalls[0]?.function.arguments, { q: "node" });
    assert.equal(result.doneReason, "STOP");
  });
});

describe("ollama adapter", () => {
  it("reads model names from /api/tags", async () => {
    globalThis.fetch = (async (url) => {
      assert.equal(String(url), "http://127.0.0.1:9/api/tags");
      return new Response(JSON.stringify({ models: [{ name: "qwen2.5:14b" }, { name: "" }] }), { status: 200 });
    }) as typeof fetch;
    const adapter = new OllamaAdapter(options());
    assert.deepEqual(await adapter.listModels(), [{ remoteId: "qwen2.5:14b" }]);
  });
});
