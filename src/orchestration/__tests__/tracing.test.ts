import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Tracer, formatTraceparent, parseTraceparent, spansForTask, spansForTrace, pruneSpans, toOtlpJson, exportOtlp, redactSecrets, resetTraceSchemaFlag } from "../tracing/tracer.js";
import { GENAI, SPAN } from "../tracing/genai.js";

// Point the app DB at a temp folder BEFORE any database() call.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-orch-tracing-"));
process.env.LOAM_DATA_DIR = tmp;
process.env.MANUS_LOCAL_DATA_DIR = tmp;
const { resetDb } = await import("../../server/sqliteStore.js");
resetTraceSchemaFlag();

const base = { enabled: true, sampleRate: 1, captureContent: false, maxSpansPerTrace: 5000 };

test("traceparent round-trips and rejects malformed or all-zero ids", () => {
  const c = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true };
  assert.equal(formatTraceparent(c), "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
  assert.deepEqual(parseTraceparent(formatTraceparent(c)), c);
  assert.equal(parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01"), undefined);
  assert.equal(parseTraceparent("garbage"), undefined);
});

test("spans persist with parent links, GenAI attributes and status", async () => {
  let t = 1_000;
  const tr = new Tracer({ ...base, now: () => (t += 10) });
  const root = tr.startSpan(SPAN.run, { taskId: "task_a", sessionId: "task_a" });
  await tr.withSpan(SPAN.modelCall, { parent: root.context, kind: "client", taskId: "task_a", attributes: { [GENAI.requestModel]: "gpt-oss:120b:cloud" } }, async (s) => {
    s.setAttribute(GENAI.inputTokens, 120);
    s.recordContent("output", "hello");
  });
  await assert.rejects(tr.withSpan(SPAN.toolCall, { parent: root.context, taskId: "task_a" }, async () => {
    throw new Error("boom sk-abcdefghijklmnopqrstuvwx");
  }));
  root.end("ok");
  const spans = spansForTask("task_a");
  assert.equal(spans.length, 3);
  const [r, m, x] = spans;
  assert.equal(r?.parentSpanId, null);
  assert.equal(m?.parentSpanId, r?.spanId);
  assert.equal(m?.attributes[GENAI.inputTokens], 120);
  assert.equal(m?.attributes["loam.output.chars"], 5);
  assert.equal(m?.attributes["loam.output.text"], undefined, "content capture is off by default");
  assert.equal(x?.status, "error");
  assert.ok(!(x?.statusMessage ?? "").includes("sk-abcdef"), "secrets are redacted");
  assert.equal(spansForTrace(r?.traceId ?? "").length, 3);
});

test("sampleRate 0 stores nothing but still propagates context", () => {
  const tr = new Tracer({ ...base, sampleRate: 0 });
  const s = tr.startSpan(SPAN.run, { taskId: "task_unsampled" });
  s.end();
  assert.equal(s.context.sampled, false);
  assert.equal(s.context.traceId.length, 32);
  assert.equal(spansForTask("task_unsampled").length, 0);
});

test("maxSpansPerTrace caps one trace", () => {
  const tr = new Tracer({ ...base, maxSpansPerTrace: 3 });
  const root = tr.startSpan("r", { taskId: "task_cap" });
  for (let i = 0; i < 5; i++) tr.startSpan("c", { parent: root.context, taskId: "task_cap" }).end();
  assert.equal(spansForTask("task_cap").length, 3);
});

test("prune removes old spans; OTLP export is off without an endpoint", async () => {
  const tr = new Tracer({ ...base, now: () => 5 });
  tr.startSpan("old", { taskId: "task_old" }).end();
  assert.equal(pruneSpans(1, 86_400_000 + 6), 1);
  assert.equal(spansForTask("task_old").length, 0);
  let called = 0;
  const fake = (async () => {
    called++;
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  assert.equal(await exportOtlp("", spansForTask("task_a"), fake), false);
  assert.equal(called, 0);
  const body = toOtlpJson(spansForTask("task_a")) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }> };
  assert.equal(body.resourceSpans[0]?.scopeSpans[0]?.spans.length, 3);
  assert.equal(await exportOtlp("http://127.0.0.1:4318", spansForTask("task_a"), fake), true);
  assert.equal(called, 1);
});

test("redactSecrets covers common token shapes", () => {
  assert.equal(redactSecrets("key ghp_abcdefghijklmnopqrstuvwxyz123 end"), "key [redacted] end");
});

test.after(() => { try { resetDb(); } catch { /* closed */ } });
