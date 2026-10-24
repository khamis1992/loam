import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolPair } from "../types.js";
import { decide } from "../decide.js";

const pair = (pinned = false): ToolPair => ({
  id: "p", assistantIndex: 1, callIndex: 0, toolIndex: 2, tool: "file_read", argsJson: "{}",
  resultChars: 10, ok: true, stepsAgo: 3, pinned,
});

test("pinned wins over any score", () => {
  const d = decide(pair(true), { keepCall: 0, keepResult: 0 }, 0.5);
  assert.deepEqual([d.action, d.reason], ["keep", "pinned"]);
});

test("result score at the threshold keeps", () => {
  const d = decide(pair(), { keepCall: 0, keepResult: 0.5 }, 0.5);
  assert.deepEqual([d.action, d.reason], ["keep", "kept"]);
});

test("low result but useful call truncates the result", () => {
  const d = decide(pair(), { keepCall: 0.6, keepResult: 0.1 }, 0.5);
  assert.deepEqual([d.action, d.reason], ["truncate_result", "result_truncated"]);
});

test("both low drops the call", () => {
  const d = decide(pair(), { keepCall: 0.2, keepResult: 0.1 }, 0.5);
  assert.deepEqual([d.action, d.reason], ["drop_call", "call_dropped"]);
  assert.equal(d.id, "p");
  assert.equal(d.tool, "file_read");
});
