/**
 * Lint test for the long, prescriptive tool descriptions required of the
 * `coding` profile and the other commonly used tools (task C4).
 *
 * The coding profile is the harness equivalent of a small, sharp tool set: a
 * small model is handed only ~19 names, so every one of them has to carry its
 * full usage contract in the description — when to use it, when not to, the
 * path rules and the parallel-batching rules — instead of relying on a long
 * system prompt. These assertions keep that contract from silently rotting:
 * every implemented coding tool must have a description of at least 200
 * characters that includes a "When NOT to use" section.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CODING_PROFILE } from "../taskToolScope.js";
import type { OllamaClient } from "../../ollama.js";
import { ToolRegistry } from "../../tools/registry.js";
import { fileTools } from "../../tools/files.js";
import { shellTools } from "../../tools/shell.js";
import { webTools } from "../../tools/web.js";
import { symbolTools } from "../../tools/symbols.js";
import { createFinishTools } from "../../tools/finishTools.js";
import { createMultiEditTools } from "../../tools/multiEdit.js";
import { createSubagentTools } from "../../tools/subagents.js";
import { createAskUserTools } from "../../tools/askUserTools.js";

/** Minimum description length for a tool that a small model must rely on. */
const MIN_DESCRIPTION = 200;
/** The prescriptive section every linted description must carry. */
const NOT_TO_USE = /When NOT to use/i;

/**
 * Coding-profile tools that are declared in the profile but not yet
 * implemented; they are owned by other tasks (grep/glob by C5, todo_write by
 * C6, plan_exit by C13). They have no registered description to lint until
 * those land, at which point they must be removed from this list so their
 * descriptions are covered too.
 */
const PENDING_CODING_TOOLS = ["grep", "glob", "todo_write", "plan_exit"];

/** Other commonly used tools held to the same description standard. */
const COMMON_TOOLS = [
  "file_search",
  "file_stat",
  "file_mkdir",
  "file_move",
  "file_delete",
  "shell_write",
  "shell_list",
  "think",
];

/** A registry built from the real tool modules the coding profile draws from. */
function codingRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(fileTools);
  registry.registerAll(shellTools);
  registry.registerAll(webTools);
  registry.registerAll(symbolTools());
  registry.registerAll(createFinishTools());
  registry.registerAll(createMultiEditTools());
  registry.registerAll(createSubagentTools({} as OllamaClient, new ToolRegistry()));
  // N9: `ask_user` is a coding-profile tool, so its description is linted too.
  registry.registerAll(createAskUserTools());
  return registry;
}

function assertPrescriptive(name: string, description: string): void {
  assert.ok(
    description.length >= MIN_DESCRIPTION,
    `${name} description is ${description.length} chars; the coding profile requires at least ${MIN_DESCRIPTION}`,
  );
  assert.match(
    description,
    NOT_TO_USE,
    `${name} description must include a "When NOT to use" section`,
  );
}

describe("coding tool descriptions", () => {
  it("gives every implemented coding-profile tool a long, prescriptive description", () => {
    const registry = codingRegistry();
    const present = CODING_PROFILE.tools.filter((name) => registry.get(name) !== undefined);
    assert.ok(
      present.length >= 10,
      `expected most coding-profile tools to be registered, got ${present.length}: ${present.join(", ")}`,
    );
    for (const name of present) {
      assertPrescriptive(name, registry.get(name)!.description);
    }
  });

  it("keeps every coding-profile tool either linted or explicitly pending", () => {
    const registry = codingRegistry();
    const pending = new Set(PENDING_CODING_TOOLS);
    for (const name of CODING_PROFILE.tools) {
      const registered = registry.get(name) !== undefined;
      assert.ok(
        registered || pending.has(name),
        `${name} is neither registered nor listed in PENDING_CODING_TOOLS; lint its description or add it to the pending list`,
      );
    }
  });

  it("drops a pending entry as soon as its tool is registered", () => {
    const registry = codingRegistry();
    for (const name of PENDING_CODING_TOOLS) {
      assert.equal(
        registry.get(name),
        undefined,
        `${name} is registered now; remove it from PENDING_CODING_TOOLS so its description is linted`,
      );
    }
  });
});

describe("commonly used tool descriptions", () => {
  it("gives the other commonly used tools the same long, prescriptive description", () => {
    const registry = codingRegistry();
    for (const name of COMMON_TOOLS) {
      const tool = registry.get(name);
      assert.ok(tool, `${name} is not registered`);
      assertPrescriptive(name, tool!.description);
    }
  });
});
