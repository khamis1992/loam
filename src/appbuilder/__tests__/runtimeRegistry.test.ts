import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry } from "../../tools/registry.js";
import { createAppBuilderTools } from "../tools.js";
import { appBuilderRegistry } from "../runtime.js";

test("appBuilderRegistry creates a standalone app toolset", () => {
  const registry = appBuilderRegistry();
  const expected = createAppBuilderTools().map((tool) => tool.name).sort();
  assert.deepEqual(registry.names(), expected);
});

test("appBuilderRegistry replaces app tools already registered by the server", () => {
  const base = new ToolRegistry();
  base.registerAll(createAppBuilderTools());
  base.register({ name: "server_marker", description: "", parameters: {}, async run() { return { ok: true, content: "ok" }; } });
  const original = base.get("app_task_create");

  const registry = appBuilderRegistry(base);

  assert.notEqual(registry, base);
  assert.equal(base.get("app_task_create"), original);
  assert.notEqual(registry.get("app_task_create"), original);
  assert.equal(registry.get("server_marker"), base.get("server_marker"));
  assert.deepEqual(registry.names(), base.names());
});
