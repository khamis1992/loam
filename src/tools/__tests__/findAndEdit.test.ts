/**
 * Tests for find_and_edit (findAndEdit.ts).
 *
 * Guarantees under test:
 *  - 20 matches across files are edited correctly via a mocked model sub-call
 *  - exclude_glob skips matching files
 *  - a "no change" decision leaves the file untouched
 *  - dry_run produces no writes
 *  - max_matches caps the number of matches processed
 *  - the default path calls through the shared model layer (ollama.chat)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ChatMessage, OllamaClient } from "../../ollama.js";
import type { Tool, ToolContext } from "../registry.js";
import { createFindAndEditTools, parseEditDecision, type FindAndEditModelCall } from "../findAndEdit.js";

let tmpDir = "";

function write(rel: string, content: string): string {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

function read(rel: string): string {
  return fs.readFileSync(path.join(tmpDir, rel), "utf8");
}

function makeTool(callModel?: FindAndEditModelCall): Tool {
  const tools = createFindAndEditTools({ ollama: {} as OllamaClient, ...(callModel ? { callModel } : {}) });
  const found = tools.find((t) => t.name === "find_and_edit");
  assert.ok(found, "find_and_edit tool is exported");
  return found;
}

function ctx(): ToolContext {
  return { cfg: {} as never, workspace: tmpDir, emit: () => {} };
}

function run(tool: Tool, args: Record<string, unknown>) {
  return tool.run(args, ctx());
}

/** Extract the matched text from the tool's model prompt. */
function matchFromPrompt(messages: ChatMessage[]): string {
  const user = messages.find((m) => m.role === "user");
  assert.ok(user, "model call has a user message");
  const lines = user.content.split("\n");
  const idx = lines.indexOf("Match:");
  assert.ok(idx >= 0, "prompt carries a Match section");
  return (lines[idx + 1] ?? "").trim();
}

/** A mock model that rewrites `TODO-n` -> `DONE-n` for every match. */
function rewritingModel(counter?: { calls: number }): FindAndEditModelCall {
  return async (messages) => {
    if (counter) counter.calls++;
    const match = matchFromPrompt(messages);
    return JSON.stringify({ action: "edit", find: match, replace: match.replace("TODO", "DONE") });
  };
}

/** A mock model that reports no change for every match. */
const noChangeModel: FindAndEditModelCall = async () => JSON.stringify({ action: "no_change" });

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-findandedit-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("find_and_edit", () => {
  it("edits 20 matches across files via the model sub-call", async () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts"];
    let n = 0;
    for (const f of files) {
      const lines = Array.from({ length: 5 }, () => `const v${++n} = "TODO-${n}";`);
      write(f, `${lines.join("\n")}\n`);
    }

    const counter = { calls: 0 };
    const res = await run(makeTool(rewritingModel(counter)), {
      dir: ".",
      regex: "TODO-(\\d+)",
      instruction: "Mark each TODO as done.",
    });

    assert.equal(res.ok, true);
    assert.equal(counter.calls, 20, "one model sub-call per match");
    assert.match(res.content, /20 match\(es\)/);
    assert.match(res.content, /combined: \+20 -20/);
    for (let i = 1; i <= 20; i++) {
      assert.ok(!read(files[Math.floor((i - 1) / 5)]!).includes(`TODO-${i}`), `TODO-${i} was edited`);
    }
    assert.ok(read("a.ts").includes("DONE-1"));
  });

  it("skips files matched by exclude_glob", async () => {
    write("keep.ts", 'const a = "TODO-1";\nconst b = "TODO-2";\n');
    write("notes.md", 'const c = "TODO-3";\n');

    const res = await run(makeTool(rewritingModel()), {
      dir: ".",
      regex: "TODO-(\\d+)",
      instruction: "Mark each TODO as done.",
      exclude_glob: "*.md",
    });

    assert.equal(res.ok, true);
    assert.ok(read("keep.ts").includes("DONE-1"));
    assert.ok(read("keep.ts").includes("DONE-2"));
    assert.ok(read("notes.md").includes("TODO-3"), "excluded file is untouched");
  });

  it("supports ** globs for root-level and nested files", async () => {
    write("root.test.ts", 'const a = "TODO-1";\n');
    write("nested/deep.test.ts", 'const b = "TODO-2";\n');
    write("nested/other.ts", 'const c = "TODO-3";\n');

    const res = await run(makeTool(rewritingModel()), {
      dir: ".",
      regex: "TODO-(\\d+)",
      instruction: "Mark each TODO as done.",
      file_glob: "**/*.test.ts",
    });

    assert.equal(res.ok, true);
    assert.ok(read("root.test.ts").includes("DONE-1"), "root-level ** glob match is edited");
    assert.ok(read("nested/deep.test.ts").includes("DONE-2"), "nested ** glob match is edited");
    assert.ok(read("nested/other.ts").includes("TODO-3"), "non-matching file is skipped");
  });

  it("respects a no-change decision", async () => {
    write("a.ts", 'const a = "TODO-1";\n');
    const before = read("a.ts");

    const res = await run(makeTool(noChangeModel), {
      dir: ".",
      regex: "TODO-(\\d+)",
      instruction: "Leave it alone.",
    });

    assert.equal(res.ok, true);
    assert.match(res.content, /1 no-change/);
    assert.equal(read("a.ts"), before);
  });

  it("dry_run makes no writes", async () => {
    write("a.ts", 'const a = "TODO-1";\nconst b = "TODO-2";\n');
    const before = read("a.ts");

    const res = await run(makeTool(rewritingModel()), {
      dir: ".",
      regex: "TODO-(\\d+)",
      instruction: "Mark each TODO as done.",
      dry_run: true,
    });

    assert.equal(res.ok, true);
    assert.match(res.content, /dry run/i);
    assert.match(res.content, /would change/);
    assert.equal(read("a.ts"), before, "dry_run must not write");
  });

  it("enforces max_matches", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `const v${i} = "TODO-${i}";`);
    write("a.ts", `${lines.join("\n")}\n`);

    const counter = { calls: 0 };
    const res = await run(makeTool(rewritingModel(counter)), {
      dir: ".",
      regex: "TODO-(\\d+)",
      instruction: "Mark each TODO as done.",
      max_matches: 5,
    });

    assert.equal(res.ok, true);
    assert.equal(counter.calls, 5, "model is only asked about the capped number of matches");
    assert.match(res.content, /5 match\(es\)/);
    const content = read("a.ts");
    assert.ok(content.includes("DONE-0"));
    assert.ok(content.includes("TODO-5"), "matches beyond the cap are untouched");
  });

  it("calls the shared model layer when no callModel is injected", async () => {
    write("a.ts", 'const a = "TODO-1";\n');
    const seen: ChatMessage[][] = [];
    const stub = {
      chat: async (opts: { messages: ChatMessage[] }) => {
        seen.push(opts.messages);
        const match = matchFromPrompt(opts.messages);
        return {
          content: JSON.stringify({ action: "edit", find: match, replace: "DONE-1" }),
          model: "fixture",
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        };
      },
    } as unknown as OllamaClient;

    const tools = createFindAndEditTools({ ollama: stub });
    const tool = tools.find((t) => t.name === "find_and_edit")!;
    const res = await tool.run(
      { dir: ".", regex: "TODO-(\\d+)", instruction: "Mark done." },
      { cfg: { model: "fixture", fallbackModel: "fixture", agent: { temperature: 0, requestTimeoutMs: 1000 } } as never, workspace: tmpDir, emit: () => {} },
    );

    assert.equal(res.ok, true);
    assert.equal(seen.length, 1, "the default path sub-calls the model layer once per match");
    assert.equal(seen[0]![0]!.role, "system");
    assert.ok(read("a.ts").includes("DONE-1"));
  });

  it("rejects an invalid regex", async () => {
    write("a.ts", "hello\n");
    const res = await run(makeTool(rewritingModel()), { dir: ".", regex: "([", instruction: "x" });
    assert.equal(res.ok, false);
    assert.match(res.content, /invalid regex/i);
  });

  it("rejects a directory outside the workspace", async () => {
    const res = await run(makeTool(rewritingModel()), {
      dir: path.join(os.tmpdir(), "definitely-outside"),
      regex: "TODO",
      instruction: "x",
    });
    assert.equal(res.ok, false);
    assert.match(res.content, /outside workspace/i);
  });

  it("reports no matches honestly", async () => {
    write("a.ts", "hello\n");
    const res = await run(makeTool(rewritingModel()), { dir: ".", regex: "TODO-(\\d+)", instruction: "x" });
    assert.equal(res.ok, true);
    assert.match(res.content, /no matches/i);
  });

  it("skips an ambiguous find returned by the model", async () => {
    write("a.ts", 'const a = "TODO";\nconst b = "TODO";\n');
    const ambiguous: FindAndEditModelCall = async () => JSON.stringify({ action: "edit", find: "TODO", replace: "DONE" });
    const res = await run(makeTool(ambiguous), { dir: ".", regex: "TODO", instruction: "x" });
    assert.equal(res.ok, true);
    assert.match(res.content, /ambiguous/i);
    assert.ok(read("a.ts").includes("TODO"), "ambiguous edit is not applied");
  });
});

describe("parseEditDecision", () => {
  it("parses an edit with a fallback find", () => {
    assert.deepEqual(parseEditDecision('{"action":"edit","replace":"x"}', "fallback"), { action: "edit", find: "fallback", replace: "x" });
  });

  it("parses a fenced no-change", () => {
    assert.deepEqual(parseEditDecision('```json\n{"action":"no_change"}\n```', "fallback"), { action: "no_change" });
  });

  it("treats unparseable output as no change", () => {
    assert.deepEqual(parseEditDecision("I am not json", "fallback"), { action: "no_change" });
  });
});
