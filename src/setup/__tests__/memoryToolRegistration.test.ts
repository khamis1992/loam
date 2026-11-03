import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryStore } from "../../memory/store.js";
import { ToolRegistry } from "../../tools/registry.js";
import { registerLongTermMemoryTools } from "../runtime.js";

test("recall and legacy memory coexist without duplicate memory_store registration", () => {
  const registry = new ToolRegistry();
  registerLongTermMemoryTools(registry, {} as MemoryStore, true, null as never);
  assert.equal(new Set(registry.names()).size, registry.names().length);
  assert.match(registry.get("memory_store")!.description, /long-term memory/);
  assert.ok(registry.get("memory_search"), "legacy semantic search stays available");
  assert.ok(registry.get("memory_recall"), "the new recall surface is registered");
});

test("legacy memory keeps its original store when recall is disabled", () => {
  const registry = new ToolRegistry();
  registerLongTermMemoryTools(registry, {} as MemoryStore, false, null as never);
  assert.match(registry.get("memory_store")!.description, /semantic memory/);
  assert.equal(registry.get("memory_recall"), undefined);
});
