/**
 * Prompt-cache breakpoint.
 *
 * The system message is the stable prefix of every run. With `cacheControl` the
 * cloud request marks it as an ephemeral cache breakpoint; without it the
 * request stays a plain string message (so providers that dislike blocks are
 * unaffected). The stub captures the request body — no network.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { OllamaClient } from "../ollama.js";

const originalFetch = globalThis.fetch;

function stubStream(): { body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const chunk = JSON.stringify({ model: "claude-x", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] });
    const done = JSON.stringify({ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${chunk}\n\ndata: ${done}\n\ndata: [DONE]\n\n`));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { body: () => captured };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("cloud prompt cache breakpoint", () => {
  it("marks the system message with cache_control when enabled", async () => {
    const stub = stubStream();
    const client = new OllamaClient("http://127.0.0.1:1", { baseUrl: "https://cloud.test", apiKey: "k" });
    await client.chat({
      model: "claude-x:cloud",
      cacheControl: true,
      messages: [
        { role: "system", content: "stable prefix" },
        { role: "user", content: "hi" },
      ],
    });
    const messages = stub.body()["messages"] as Array<{ role: string; content: unknown }>;
    assert.deepEqual(messages[0]!.content, [
      { type: "text", text: "stable prefix", cache_control: { type: "ephemeral" } },
    ]);
    assert.equal(messages[1]!.content, "hi");
  });

  it("keeps a plain string message when disabled", async () => {
    const stub = stubStream();
    const client = new OllamaClient("http://127.0.0.1:1", { baseUrl: "https://cloud.test", apiKey: "k" });
    await client.chat({
      model: "claude-x:cloud",
      messages: [{ role: "system", content: "stable prefix" }],
    });
    const messages = stub.body()["messages"] as Array<{ content: unknown }>;
    assert.equal(messages[0]!.content, "stable prefix");
  });
});
