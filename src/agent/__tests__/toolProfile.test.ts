/**
 * Unit tests: the named tool profiles, focused on the `coding` profile.
 *
 * A profile is a lean capability subset. The coding profile is the harness
 * equivalent of a small, sharp tool set: it must expose only the core coding
 * tools and stay at or under 18 names, so a small model is never handed the
 * 80+ tools the full registry can register.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import {
  CODING_PROFILE,
  codingTaskTools,
  getToolProfile,
  isToolProfile,
  listToolProfiles,
  profileScopedTools,
  profileToolNames,
  taskScopedTools,
} from "../taskToolScope.js";
import { ToolRegistry, type Tool } from "../../tools/registry.js";

/** The coding profile's tools, sorted the way ToolRegistry.names() returns them. */
const CODING_TOOLS_SORTED = [
  "delegate_task",
  "file_edit",
  "file_list",
  "file_multi_edit",
  "file_read",
  "file_write",
  "finish",
  "glob",
  "grep",
  "plan_exit",
  "shell_kill",
  "shell_read",
  "shell_run",
  "shell_start",
  "suggest_plan",
  "todo_write",
  "web_fetch",
  "web_search",
];

/** Tools that belong to other profiles and must never leak into a coding task. */
const NON_CODING_TOOLS = [
  "browser_open",
  "preview_serve",
  "vault_ref",
  "office_export",
  "memory_store",
  "computer_click",
];

function tool(name: string): Tool {
  return { name, description: name, parameters: {}, run: async () => ({ ok: true, content: name }) };
}

function registryWith(names: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of names) registry.register(tool(name));
  return registry;
}

function codingRegistry(): ToolRegistry {
  return registryWith([...CODING_PROFILE.tools, ...NON_CODING_TOOLS]);
}

describe("coding tool profile", () => {
  it("registers the coding profile under its id", () => {
    assert.equal(isToolProfile("coding"), true);
    assert.equal(getToolProfile("coding")?.id, "coding");
    assert.deepEqual(listToolProfiles().map((profile) => profile.id), ["coding"]);
  });

  it("keeps a coding task's tool list at or under 18 names", () => {
    const names = codingTaskTools(codingRegistry()).names();
    assert.ok(
      names.length <= 18,
      `coding tool list must be <= 18 names, got ${names.length}: ${names.join(", ")}`,
    );
  });

  it("snapshots the coding task's tool list", () => {
    assert.deepEqual(codingTaskTools(codingRegistry()).names(), CODING_TOOLS_SORTED);
  });

  it("never exposes tools outside the coding profile", () => {
    const names = codingTaskTools(codingRegistry()).names();
    for (const name of NON_CODING_TOOLS) {
      assert.ok(!names.includes(name), `${name} must not be exposed to a coding task`);
    }
  });

  it("forProfile mirrors the profile helper and rejects unknown profiles", () => {
    const registry = codingRegistry();
    assert.deepEqual(registry.forProfile("coding").names(), codingTaskTools(registry).names());
    assert.throws(() => registry.forProfile("nope"), /Unknown tool profile/);
    assert.throws(() => profileScopedTools(registry, "nope"), /Unknown tool profile/);
  });

  it("resolves only the profile tools that are actually registered", () => {
    const registry = registryWith(["file_read", "file_write", "shell_run", "web_search"]);
    assert.deepEqual(profileToolNames("coding", registry.names()), [
      "file_read",
      "file_write",
      "shell_run",
      "web_search",
    ]);
  });

  it("applies the coding profile on top of a file-only restriction", () => {
    const names = taskScopedTools(codingRegistry(), "استخدم أدوات الملفات فقط", [], true, "coding").names();
    assert.deepEqual(names, ["file_edit", "file_list", "file_read", "file_write"]);
  });

  it("leaves an unrestricted task untouched when no profile is requested", () => {
    const registry = codingRegistry();
    assert.deepEqual(taskScopedTools(registry, "Read the result").names(), registry.names());
  });
});
