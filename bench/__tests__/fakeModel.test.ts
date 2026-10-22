/**
 * Tests for bench/fakeModel.ts (J2 mock-model benchmark harness).
 *
 * Guarantees under test:
 *  - the scripted read -> edit -> bash -> final sequence is replayed in order
 *  - SSE output is well-formed OpenAI chunks plus the trailing [DONE]
 *  - non-stream requests return a single chat.completion JSON body
 *  - /v1/models and /api/tags report the configured model id
 *  - the default port never clashes with real Ollama (11434)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { countToolMessages, FakeModelServer, formatSse, modelListBody, ollamaTagsBody, type ScriptedTurn } from "../fakeModel.js";

function parseSse(body: string): { events: Array<Record<string, unknown>>; done: boolean; frames: string[] } {
  assert.match(body, /^data: /m, "every SSE frame starts with 'data: '");
  assert.ok(body.endsWith("data: [DONE]\n\n"), "stream ends with [DONE]");
  const frames = body.split("\n\n").filter((f) => f.trim().length > 0);
  const events: Array<Record<string, unknown>> = [];
  let done = false;
  for (const frame of frames) {
    assert.ok(frame.startsWith("data: "), `frame starts with data: ${frame}`);
    const payload = frame.slice("data: ".length);
    if (payload === "[DONE]") {
      done = true;
      continue;
    }
    events.push(JSON.parse(payload) as Record<string, unknown>);
  }
  return { events, done, frames };
}

async function post(server: FakeModelServer, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return res;
}

describe("bench/fakeModel", () => {
  it("serves /v1/models and /api/tags with the configured model id", async () => {
    const server = new FakeModelServer({ port: 0, modelId: "mock-coder" });
    await server.start();
    try {
      const models = (await (await fetch(`${server.baseUrl}/v1/models`)).json()) as {
        object: string;
        data: Array<{ id: string; object: string }>;
      };
      assert.equal(models.object, "list");
      assert.deepEqual(models.data.map((d) => d.id), ["mock-coder"]);

      const tags = (await (await fetch(`${server.baseUrl}/api/tags`)).json()) as { models: Array<{ name: string }> };
      assert.equal(tags.models[0]!.name, "mock-coder");
      assert.deepEqual(ollamaTagsBody("mock-coder").models, tags.models);
      assert.deepEqual(modelListBody("mock-coder").data, models.data);
    } finally {
      await server.stop();
    }
  });

  it("replays the default read -> edit -> bash -> final sequence as SSE tool calls", async () => {
    const server = new FakeModelServer({ port: 0 });
    await server.start();
    try {
      const expectedNames = ["read", "edit", "bash"];
      const expectedArgs = [
        { file_path: "calc.py" },
        { file_path: "calc.py", old_string: "return a - b", new_string: "return a + b" },
        { command: "python3 test_calc.py", description: "run tests" },
      ];
      for (let i = 0; i < expectedNames.length; i++) {
        const toolMessages = Array.from({ length: i }, () => ({ role: "tool", content: "ok" }));
        const res = await post(server, "/v1/chat/completions", {
          model: "mock-coder",
          stream: true,
          messages: [{ role: "user", content: "fix the failing test" }, ...toolMessages],
        });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
        const { events, done, frames } = parseSse(await res.text());
        assert.equal(done, true);
        assert.ok(frames.length >= 2, "at least one data frame plus [DONE]");

        const toolCallChunk = events.find((e) => (e.choices?.[0] as any)?.delta?.tool_calls);
        assert.ok(toolCallChunk, "stream contains a tool_call chunk");
        const toolCall = (toolCallChunk!.choices[0] as any).delta.tool_calls[0];
        assert.equal(toolCall.type, "function");
        assert.equal(toolCall.function.name, expectedNames[i]);
        assert.equal(typeof toolCall.function.arguments, "string");
        assert.deepEqual(JSON.parse(toolCall.function.arguments), expectedArgs[i]);
        assert.equal((toolCallChunk!.choices[0] as any).delta.role, "assistant");

        const finish = events[events.length - 1]!;
        assert.equal((finish.choices[0] as any).finish_reason, "tool_calls");
        for (const event of events) {
          assert.equal(event.object, "chat.completion.chunk");
          assert.equal(event.model, "mock-coder");
        }
      }

      const final = await post(server, "/v1/chat/completions", {
        model: "mock-coder",
        stream: true,
        messages: [
          { role: "user", content: "fix the failing test" },
          { role: "tool", content: "ok" },
          { role: "tool", content: "ok" },
          { role: "tool", content: "ok" },
        ],
      });
      const { events } = parseSse(await final.text());
      const contentChunk = events.find((e) => (e.choices?.[0] as any)?.delta?.content);
      assert.equal((contentChunk!.choices[0] as any).delta.content, "Fixed add(): it subtracted instead of adding. Tests pass.");
      assert.equal((events[events.length - 1]!.choices[0] as any).finish_reason, "stop");
    } finally {
      await server.stop();
    }
  });

  it("honours a custom sequence, drives off tool messages, and repeats the last turn", async () => {
    const sequence: ScriptedTurn[] = [{ text: "one" }, { tool: { name: "noop", arguments: {} } }];
    const server = new FakeModelServer({ port: 0, sequence });
    await server.start();
    try {
      const send = async (toolCount: number) => {
        const res = await post(server, "/v1/chat/completions", {
          model: "mock-coder",
          stream: true,
          messages: [
            { role: "user", content: "fix" },
            ...Array.from({ length: toolCount }, () => ({ role: "tool", content: "ok" })),
          ],
        });
        return parseSse(await res.text());
      };
      const first = await send(0);
      assert.equal((first.events[0]!.choices[0] as any).delta.content, "one");

      const second = await send(1);
      assert.ok(second.events.some((e) => (e.choices?.[0] as any)?.delta?.tool_calls), "second turn is a tool call");

      const third = await send(5);
      assert.ok(
        third.events.some((e) => (e.choices?.[0] as any)?.delta?.tool_calls),
        "last turn repeats for extra requests",
      );
    } finally {
      await server.stop();
    }
  });

  it("returns a single JSON body for non-stream requests", async () => {
    const server = new FakeModelServer({ port: 0 });
    await server.start();
    try {
      const res = await post(server, "/v1/chat/completions", { model: "mock-coder", stream: false, messages: [] });
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);
      const body = (await res.json()) as {
        object: string;
        model: string;
        choices: Array<{ message: Record<string, unknown>; finish_reason: string }>;
        usage: { prompt_tokens: number; total_tokens: number };
      };
      assert.equal(body.object, "chat.completion");
      assert.equal(body.model, "mock-coder");
      assert.equal(body.choices[0]!.finish_reason, "tool_calls");
      assert.equal((body.choices[0]!.message.tool_calls as unknown[]).length, 1);
      assert.equal(body.usage.total_tokens, 110);
    } finally {
      await server.stop();
    }
  });

  it("records requests and rejects unknown paths", async () => {
    const server = new FakeModelServer({ port: 0 });
    await server.start();
    try {
      await post(server, "/v1/chat/completions", { model: "mock-coder", stream: false, messages: [] });
      const missing = await fetch(`${server.baseUrl}/nope`);
      assert.equal(missing.status, 404);
      assert.ok(server.requests.length >= 2);
      assert.equal(server.requests[0]!.path, "/v1/chat/completions");
      assert.equal(server.requests[0]!.method, "POST");
    } finally {
      await server.stop();
    }
  });

  it("defaults to port 11435 so it never clashes with real Ollama on 11434", () => {
    const server = new FakeModelServer();
    assert.equal(server.requestedPort, 11435);
    assert.notEqual(server.requestedPort, 11434);
  });

  it("drives the script from tool_call_id (OpenAI) and tool_name (Ollama) messages", () => {
    assert.equal(countToolMessages({ messages: [{ role: "tool", content: "x" }] }), 1);
    assert.equal(countToolMessages({ messages: [{ role: "tool", tool_call_id: "c1", content: "x" }] }), 1);
    assert.equal(countToolMessages({ messages: [{ role: "assistant", tool_name: "read", content: "x" }] }), 1);
    assert.equal(countToolMessages({ messages: [{ role: "assistant", content: "hi" }] }), 0);
    assert.equal(countToolMessages({}), 0);
    assert.equal(countToolMessages(null), 0);
  });

  it("formatSse terminates every frame with a blank line and [DONE]", () => {
    const body = formatSse([{ a: 1 }]);
    assert.equal(body, 'data: {"a":1}\n\ndata: [DONE]\n\n');
  });
});
