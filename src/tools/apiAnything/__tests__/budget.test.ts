import { test } from "node:test";
import assert from "node:assert/strict";
import { fitJson } from "../budget.js";

test("small values are unchanged", () => {
  assert.equal(fitJson({ ok: true, class: "ok", data: [1, 2] }, 15_000), '{"ok":true,"class":"ok","data":[1,2]}');
});

test("large lists are halved into valid JSON with a count", () => {
  const big = { ok: true, class: "ok", tier: 1, data: Array.from({ length: 500 }, (_, i) => ({ title: "x".repeat(80) + i, id: i })), ms: 5 };
  const out = fitJson(big, 15_000);
  assert.ok(out.length <= 15_000);
  const v = JSON.parse(out);
  assert.equal(v.truncated, true);
  assert.equal(v.ok, true);
  assert.equal(v.omittedItems + v.data.length, 500);
});

test("one huge string is cut, still valid JSON", () => {
  const out = fitJson({ ok: true, class: "ok", data: "y".repeat(100_000) }, 15_000);
  assert.ok(out.length <= 15_000);
  assert.ok(JSON.parse(out).cutStrings >= 1);
});
