/**
 * lazy-senior P4: the task metrics aggregator — the single definition behind
 * GET /api/tasks/:id/metrics and the task panel band.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import { computeTaskMetrics, metricsRows } from "../taskMetrics.js";
import type { StepRecord } from "../db.js";

function step(at: string, type: string, data?: unknown): StepRecord {
  return { at, type, data };
}

describe("computeTaskMetrics", () => {
  it("returns nulls for an empty or minimal log", () => {
    const empty = computeTaskMetrics([]);
    assert.equal(empty.filesTouched, 0);
    assert.equal(empty.reuseRatio, null);
    assert.equal(empty.lastCheck, null);
  });

  it("counts a reuse-style edit: read then edit an existing file", () => {
    const metrics = computeTaskMetrics([
      step("2026-10-31T10:00:00Z", "tool_call", { name: "file_read", args: { path: "src/a.ts" } }),
      step("2026-10-31T10:00:05Z", "tool_call", { name: "file_edit", args: { path: "src/a.ts", find: "one\ntwo", replace: "one\nTWO\nthree" } }),
      step("2026-10-31T10:00:09Z", "tool_result", { ok: true }),
      step("2026-10-31T10:00:10Z", "usage", { promptTokens: 900, completionTokens: 120, model: "qwen36" }),
      step("2026-10-31T10:00:12Z", "done", { text: "done", steps: 3, model: "qwen36" }),
    ]);
    assert.equal(metrics.filesTouched, 1);
    assert.equal(metrics.newFiles, 0);
    assert.equal(metrics.reuseRatio, 1);
    assert.equal(metrics.linesAdded, 3);
    assert.equal(metrics.linesRemoved, 2);
    assert.equal(metrics.tokensIn, 900);
    assert.equal(metrics.tokensOut, 120);
    assert.equal(metrics.model, "qwen36");
    assert.equal(metrics.turns, 3);
    assert.equal(metrics.elapsedMs, 12000);
  });

  it("marks a write-without-read as a new file and captures the last check", () => {
    const metrics = computeTaskMetrics([
      step("2026-10-31T10:00:00Z", "tool_call", { name: "file_write", args: { path: "src/new.ts", content: "a\nb\nc" } }),
      step("2026-10-31T10:00:04Z", "tool_result", { ok: true }),
      step("2026-10-31T10:00:05Z", "tool_call", { name: "shell_run", args: { command: "npm run typecheck" } }),
      step("2026-10-31T10:00:08Z", "tool_result", { ok: true }),
      step("2026-10-31T10:00:09Z", "done", { text: "done", steps: 2, model: "m" }),
    ]);
    assert.equal(metrics.newFiles, 1);
    assert.equal(metrics.reuseRatio, 0);
    assert.equal(metrics.linesAdded, 3);
    assert.equal(metrics.lastCheck, "pass");
  });

  it("keeps the LAST verification result and records a failed check", () => {
    const metrics = computeTaskMetrics([
      step("2026-10-31T10:00:00Z", "tool_call", { name: "shell_run", args: { command: "npm test" } }),
      step("2026-10-31T10:00:04Z", "tool_result", { ok: true }),
      step("2026-10-31T10:00:05Z", "tool_call", { name: "shell_run", args: { command: "npx tsc --noEmit" } }),
      step("2026-10-31T10:00:08Z", "tool_result", { ok: false }),
    ]);
    assert.equal(metrics.lastCheck, "fail");
  });

  it("sums multi_edit edits", () => {
    const metrics = computeTaskMetrics([
      step("2026-10-31T10:00:00Z", "tool_call", {
        name: "file_multi_edit",
        args: { path: "src/b.ts", edits: [{ find: "x", replace: "x\ny" }, { find: "p\nq", replace: "p" }] },
      }),
      step("2026-10-31T10:00:04Z", "tool_result", { ok: true }),
    ]);
    assert.equal(metrics.linesAdded, 3);
    assert.equal(metrics.linesRemoved, 3);
  });
});

describe("metricsRows", () => {
  it("only emits rows for values that exist", () => {
    const rows = metricsRows(computeTaskMetrics([]));
    assert.deepEqual(rows, []);
    const rows2 = metricsRows(
      computeTaskMetrics([
        step("2026-10-31T10:00:00Z", "usage", { promptTokens: 10, completionTokens: 5 }),
        step("2026-10-31T10:00:05Z", "done", { text: "d", steps: 1, model: "m" }),
      ]),
    );
    const labels = rows2.map((r) => r.label);
    assert.ok(labels.includes("tokens"));
    assert.ok(labels.includes("time"));
    assert.ok(labels.includes("turns"));
    assert.ok(!labels.includes("files"));
  });
});
