import assert from "node:assert/strict";
import test from "node:test";
import { REA_RESULT_BUDGET_BYTES, REA_RESULT_HARD_CAP_BYTES } from "../reaAllowlist.js";
import { applyReaBudget } from "../reaBudget.js";

test("small results pass through untouched", () => {
  const out = applyReaBudget("mcp__rea__list_unknowns", "[]");
  assert.equal(out.truncated, false);
  assert.equal(out.content, "[]");
});

test("non-paging tools over the soft budget collapse to a structured preview + next pointer", () => {
  const big = "x".repeat(REA_RESULT_BUDGET_BYTES + 1);
  const out = applyReaBudget("mcp__rea__analyze_javascript_application", big);
  assert.equal(out.truncated, true);
  assert.equal(out.originalBytes, REA_RESULT_BUDGET_BYTES + 1);
  const parsed = JSON.parse(out.content) as { truncated: boolean; original_bytes: number; preview: string; next: string };
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.original_bytes, REA_RESULT_BUDGET_BYTES + 1);
  assert.equal(parsed.preview.length, 8_192);
  assert.match(parsed.next, /inspect_analysis_view/);
});

test("paging tools keep payloads up to the hard cap, then truncate with a narrower-page notice", () => {
  const mid = "y".repeat(REA_RESULT_BUDGET_BYTES + 1_000); // over soft, under hard
  assert.equal(applyReaBudget("mcp__rea__inspect_analysis_view", mid).truncated, false);
  const huge = "z".repeat(REA_RESULT_HARD_CAP_BYTES + 1);
  const out = applyReaBudget("mcp__rea__get_evidence_bundle", huge);
  assert.equal(out.truncated, true);
  assert.match(out.content, /rea budget: truncated/);
  assert.match(out.content, /offset\/limit/);
});

test("the mcp__rea__ prefix is stripped before paging-tool lookup", () => {
  const mid = "y".repeat(REA_RESULT_BUDGET_BYTES + 1_000);
  assert.equal(applyReaBudget("inspect_analysis_view", mid).truncated, false);
});
