import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolContext } from "../registry.js";
import { contextRecallTool } from "../contextRecallTool.js";
import { PrunedStore } from "../../agent/prune/prunedStore.js";

const ctx = (prunedStore?: PrunedStore): ToolContext =>
  ({ cfg: {}, workspace: ".", emit: () => {}, ...(prunedStore ? { prunedStore } : {}) }) as unknown as ToolContext;

test("recalls a stored body wrapped as untrusted", async () => {
  const store = new PrunedStore();
  store.put("p1", "file_read", "BODY-TEXT");
  const r = await contextRecallTool().run({ id: "p1" }, ctx(store));
  assert.equal(r.ok, true);
  assert.ok(r.content.includes("BODY-TEXT"));
  assert.ok(r.content.startsWith("[UNTRUSTED EXTERNAL CONTENT"));
  assert.ok(r.content.endsWith("[/UNTRUSTED EXTERNAL CONTENT]"));
});

test("unknown id and missing id fail with a clear message", async () => {
  const store = new PrunedStore();
  const unknown = await contextRecallTool().run({ id: "nope" }, ctx(store));
  assert.equal(unknown.ok, false);
  assert.ok(unknown.content.includes("nope"));
  const blank = await contextRecallTool().run({ id: "  " }, ctx(store));
  assert.equal(blank.ok, false);
});

test("without a store nothing can be recalled", async () => {
  const r = await contextRecallTool().run({ id: "p1" }, ctx());
  assert.equal(r.ok, false);
});

test("secret-tool bodies are never stored, so never recalled", async () => {
  const store = new PrunedStore();
  store.put("s1", "get_secret", "hunter2");
  const r = await contextRecallTool().run({ id: "s1" }, ctx(store));
  assert.equal(r.ok, false);
  assert.ok(!r.content.includes("hunter2"));
});
