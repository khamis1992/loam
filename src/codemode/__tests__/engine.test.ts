/**
 * Codemode engine acceptance tests (J9).
 *
 * The sandbox contract from ref/codemode: a script runs in an isolated QuickJS
 * runtime with no fs / net / process / timer API, is bounded by CPU time,
 * memory and a tool-call cap, and only its return value (capped) is surfaced.
 * These tests drive the real engine (src/codemode/engine.ts) with a fake host:
 * no model calls, no network, no filesystem writes.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import { DEFAULT_CODEMODE_LIMITS, decodeToolOutput, runCodemode, truncateResult, type CodemodeHost } from "../engine.js";

const NO_TOOLS: never[] = [];

/** A host that records calls and answers immediately from a table. */
function fakeHost(
  handlers: Record<string, (args: Record<string, unknown>) => unknown>,
  signal?: AbortSignal,
): CodemodeHost & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    signal,
    async callTool(name, args) {
      calls.push({ name, args });
      const handler = handlers[name];
      if (!handler) return { ok: false, error: `unknown tool '${name}'` };
      try {
        return { ok: true, value: handler(args) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

const echoTools = [{ name: "echo", description: "echo the payload back", parameters: { type: "object" } }];

describe("codemode engine", () => {
  it("returns only the script's return value", async () => {
    const out = await runCodemode({
      code: `return { ok: true, n: 20 };`,
      host: fakeHost({}),
      tools: NO_TOOLS,
    });
    assert.equal(out.error, undefined);
    assert.deepEqual(out.result, { ok: true, n: 20 });
    assert.equal(out.toolCalls, 0);
  });

  it("captures console output separately instead of returning it", async () => {
    const out = await runCodemode({
      code: `console.log("line one"); console.warn("careful"); return "done";`,
      host: fakeHost({}),
      tools: NO_TOOLS,
    });
    assert.equal(out.error, undefined);
    assert.equal(out.result, "done");
    assert.deepEqual(out.logs, ["line one", "[warn] careful"]);
  });

  it("reports a syntax error without throwing out of the engine", async () => {
    const out = await runCodemode({
      code: `return { broken`,
      host: fakeHost({}),
      tools: NO_TOOLS,
    });
    assert.ok(out.error, "a syntax error must be reported");
    assert.equal(out.result, undefined);
  });

  it("reports a thrown error as the run error", async () => {
    const out = await runCodemode({
      code: `throw new Error("boom");`,
      host: fakeHost({}),
      tools: NO_TOOLS,
    });
    assert.match(out.error ?? "", /boom/);
  });

  it("calls the host through tools.<name>(args) and awaits the result", async () => {
    const host = fakeHost({ echo: (args) => args });
    const out = await runCodemode({
      code: `const a = await tools.echo({ x: 1 }); const b = await tools.echo({ y: 2 }); return [a, b];`,
      host,
      tools: echoTools,
    });
    assert.equal(out.error, undefined);
    assert.deepEqual(out.result, [{ x: 1 }, { y: 2 }]);
    assert.equal(out.toolCalls, 2);
    assert.deepEqual(host.calls.map((c) => c.name), ["echo", "echo"]);
  });

  it("runs a fan-out of tool calls in one run", async () => {
    const host = fakeHost({ echo: (args) => args });
    const code = `
      const names = Array.from({ length: 20 }, (_, i) => "t" + i);
      const results = await Promise.all(names.map((n) => tools.echo({ name: n })));
      return { count: results.length, first: results[0].name, last: results[19].name };
    `;
    const out = await runCodemode({ code, host, tools: echoTools });
    assert.equal(out.error, undefined);
    assert.deepEqual(out.result, { count: 20, first: "t0", last: "t19" });
    assert.equal(out.toolCalls, 20);
  });

  it("turns a denied/failed tool call into a script error, never a bypass", async () => {
    const host = fakeHost({});
    const out = await runCodemode({
      code: `try { await tools.echo({}); return "not reached"; } catch (e) { return "caught: " + e.message; }`,
      host,
      tools: echoTools,
    });
    assert.equal(out.error, undefined);
    assert.match(String(out.result), /caught:/);
    assert.equal(host.calls.length, 1);
  });

  it("exposes tool discovery helpers to the script", async () => {
    const out = await runCodemode({
      code: `return { listed: listTools("echo").length, described: describeTool("echo").name, has: "echo" in tools, missing: describeTool("nope") === undefined };`,
      host: fakeHost({}),
      tools: echoTools,
    });
    assert.deepEqual(out.result, { listed: 1, described: "echo", has: true, missing: true });
  });

  it("rejects an unknown tool call", async () => {
    const out = await runCodemode({
      code: `try { await tools.nope({}); return "no"; } catch (e) { return "err"; }`,
      host: fakeHost({}),
      tools: echoTools,
    });
    assert.equal(out.result, "err");
  });

  it("enforces the tool-call cap", async () => {
    const host = fakeHost({ echo: () => 1 });
    const out = await runCodemode({
      code: `for (let i = 0; i < 50; i++) { await tools.echo({}); } return "done";`,
      host,
      tools: echoTools,
      limits: { maxToolCalls: 5 },
    });
    assert.equal(out.toolCalls, 6, "the over-limit call is still counted, then refused");
    assert.match(out.error ?? "", /tool call limit reached/);
  });

  it("stops the script when the wall-clock timeout passes", async () => {
    const out = await runCodemode({
      code: `while (true) {}`,
      host: fakeHost({}),
      tools: NO_TOOLS,
      limits: { timeoutMs: 60 },
    });
    assert.match(out.error ?? "", /timed out after 0s/);
  });

  it("reports an awaited infinite loop as a timeout, not a silent success", async () => {
    // An awaited loop never blocks the event loop, so the interrupt handler
    // cannot stop it; the poller must read the deadline before the wrapper
    // settles the outer promise with `undefined`.
    const out = await runCodemode({
      code: `while (true) { await Promise.resolve(); }`,
      host: fakeHost({}),
      tools: NO_TOOLS,
      limits: { timeoutMs: 60 },
    });
    assert.equal(out.error, "timed out after 0s");
    assert.equal(out.result, undefined);
  });

  it("stops when the host signal is aborted", async () => {
    const controller = new AbortController();
    const code = `while (true) { await Promise.resolve(); } return "never";`;
    const host = fakeHost({}, controller.signal);
    const run = runCodemode({ code, host, tools: NO_TOOLS, limits: { timeoutMs: 5_000 } });
    setTimeout(() => controller.abort(), 30);
    const out = await run;
    assert.equal(out.error, "cancelled");
    assert.ok(out.elapsedMs < 2_000, `an aborted run must stop promptly, took ${out.elapsedMs}ms`);
  });

  it("enforces the memory limit", async () => {
    const t0 = Date.now();
    const out = await runCodemode({
      // A small heap cap trips promptly; `new Array(1000).fill("x")` allocates
      // far more than 64 KB in QuickJS, so the loop cannot run to its deadline.
      code: `const chunks = []; while (true) { chunks.push(new Array(1000).fill("x")); }`,
      host: fakeHost({}),
      tools: NO_TOOLS,
      limits: { memoryBytes: 64 * 1024 },
    });
    assert.ok(out.error, "the allocation loop must be stopped");
    assert.match(out.error ?? "", /memory limit|out of memory/i);
    assert.ok(Date.now() - t0 < 2_000, `the memory limit must trip promptly, took ${Date.now() - t0}ms`);
  });

  it("frees the runtime without aborting on teardown", async () => {
    // A run that leaves a pending promise or a job on the runtime's object list
    // makes QuickJS abort the process in JS_FreeRuntime (its object list must be
    // empty). Each shape below previously aborted the engine; this asserts the
    // host survives and every run still reports an outcome.
    const shapes: Array<{ code: string; limits: { memoryBytes?: number; timeoutMs: number } }> = [
      { code: `return 42;`, limits: { timeoutMs: 2_000 } },
      { code: `while (true) {}`, limits: { timeoutMs: 60 } },
      { code: `while (true) { await Promise.resolve(); }`, limits: { timeoutMs: 60 } },
      { code: `const c = []; while (true) { c.push(new Array(1000).fill("x")); }`, limits: { memoryBytes: 64 * 1024, timeoutMs: 5_000 } },
      { code: `const c = []; while (true) { c.push(new Array(1000).fill("x")); await Promise.resolve(); }`, limits: { memoryBytes: 64 * 1024, timeoutMs: 5_000 } },
    ];
    for (const shape of shapes) {
      const out = await runCodemode({ code: shape.code, host: fakeHost({}), tools: NO_TOOLS, limits: shape.limits });
      assert.ok(out.error !== "codemode failed", `shape must run, got ${out.error}`);
    }
  });

  it("has no filesystem access", async () => {
    const out = await runCodemode({
      code: `return { fs: typeof globalThis.require, readFile: typeof globalThis.readFile, module: typeof globalThis.module };`,
      host: fakeHost({}),
      tools: NO_TOOLS,
    });
    assert.deepEqual(out.result, { fs: "undefined", readFile: "undefined", module: "undefined" });
  });

  it("has no network, timer or process API", async () => {
    const out = await runCodemode({
      code: `return { fetch: typeof globalThis.fetch, setTimeout: typeof globalThis.setTimeout, process: typeof globalThis.process, require: typeof globalThis.require, Worker: typeof globalThis.Worker };`,
      host: fakeHost({}),
      tools: NO_TOOLS,
    });
    assert.deepEqual(out.result, {
      fetch: "undefined",
      setTimeout: "undefined",
      process: "undefined",
      require: "undefined",
      Worker: "undefined",
    });
  });

  it("exposes no host escape hatch through the QuickJS stdlib", async () => {
    const out = await runCodemode({
      code: `return { require: typeof globalThis.require, process: typeof globalThis.process, module: typeof globalThis.module, fs: typeof globalThis.fs, os: typeof globalThis.os, fetch: typeof globalThis.fetch, setTimeout: typeof globalThis.setTimeout, Worker: typeof globalThis.Worker, Buffer: typeof globalThis.Buffer, XMLHttpRequest: typeof globalThis.XMLHttpRequest, WebSocket: typeof globalThis.WebSocket };`,
      host: fakeHost({}),
      tools: NO_TOOLS,
    });
    // Only language intrinsics (Reflect, Proxy, ArrayBuffer, ...) remain; none
    // of them reaches the Node host, and every Node/browser API is absent.
    assert.deepEqual(out.result, {
      require: "undefined",
      process: "undefined",
      module: "undefined",
      fs: "undefined",
      os: "undefined",
      fetch: "undefined",
      setTimeout: "undefined",
      Worker: "undefined",
      Buffer: "undefined",
      XMLHttpRequest: "undefined",
      WebSocket: "undefined",
    });
  });

  it("decodes a JSON tool result into a value and keeps plain text as text", () => {
    assert.deepEqual(decodeToolOutput('{"a":1}'), { a: 1 });
    assert.deepEqual(decodeToolOutput("[1,2]"), [1, 2]);
    assert.equal(decodeToolOutput("plain text"), "plain text");
    assert.equal(decodeToolOutput("{not json"), "{not json");
  });

  it("truncates the serialized return value to the cap", () => {
    const capped = truncateResult({ blob: "x".repeat(500) }, undefined, 32);
    assert.ok(capped.includes("[...truncated"));
    assert.ok(capped.length < 120);
    assert.equal(truncateResult(undefined, undefined, 32), "");
    assert.equal(truncateResult("boom", "boom", 4), "boom");
  });

  it("caps captured console output", async () => {
    const out = await runCodemode({
      code: `for (let i = 0; i < 200; i++) console.log("y".repeat(200)); return "ok";`,
      host: fakeHost({}),
      tools: NO_TOOLS,
      limits: { maxLogBytes: 1024 },
    });
    assert.equal(out.result, "ok");
    assert.equal(out.logsTruncated, true);
  });

  it("persists a session store across runs of the same task", async () => {
    const host = fakeHost({});
    const tools = NO_TOOLS;
    const first = await runCodemode({ code: `store("hits", (load("hits") || 0) + 1); return load("hits");`, host, tools });
    assert.equal(first.result, 1);
    const second = await runCodemode({ code: `store("hits", (load("hits") || 0) + 1); return load("hits");`, host, tools, store: first.store });
    assert.equal(second.result, 2);
    assert.deepEqual(second.store, { hits: 2 });
  });

  it("exposes the documented default limits", () => {
    assert.equal(DEFAULT_CODEMODE_LIMITS.memoryBytes, 64 * 1024 * 1024);
    assert.equal(DEFAULT_CODEMODE_LIMITS.maxToolCalls, 2_000);
    assert.equal(DEFAULT_CODEMODE_LIMITS.maxResultBytes, 16 * 1024);
  });
});
