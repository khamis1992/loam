/**
 * Codemode tool acceptance tests (J9).
 *
 * End-to-end: a script calls real registered tools (read + grep, 20x) and
 * returns a compact summary, so the intermediate output stays inside the script.
 * Also covers the opt-in switch and the transcript growth budget.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { ToolRegistry, type Tool, type ToolContext } from "../../tools/registry.js";

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "loam-codemode-tool-"));

/** Parse the JSON value the tool returned out of its rendered transcript text. */
function returnedValue(content: string): unknown {
  const start = content.search(/[{["]/);
  assert.notEqual(start, -1, `expected a JSON value in the tool output: ${content}`);
  return JSON.parse(content.slice(start));
}

interface CountingRegistry extends ToolRegistry {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
}

/** A real registry with the two read tools a summary script would fan out over. */
function makeRegistry(): CountingRegistry {
  const registry = new ToolRegistry() as CountingRegistry;
  registry.calls = [];
  const read: Tool = {
    name: "file_read",
    description: "read a file",
    parameters: { type: "object" },
    async run(args) {
      registry.calls.push({ name: "file_read", args });
      try {
        return { ok: true, content: fs.readFileSync(path.join(WS, String(args.path ?? "")), "utf8") };
      } catch {
        return { ok: false, content: "file not found" };
      }
    },
  };
  const grep: Tool = {
    name: "grep",
    description: "search file contents",
    parameters: { type: "object" },
    async run(args) {
      registry.calls.push({ name: "grep", args });
      const pattern = String(args.pattern ?? "").toLowerCase();
      const hits = fs
        .readdirSync(WS)
        .filter((entry) => fs.statSync(path.join(WS, entry)).isFile())
        .filter((entry) => fs.readFileSync(path.join(WS, entry), "utf8").toLowerCase().includes(pattern));
      return { ok: true, content: JSON.stringify({ pattern, hits }) };
    },
  };
  const write: Tool = {
    name: "file_write",
    description: "write a file",
    parameters: { type: "object" },
    async run(args) {
      registry.calls.push({ name: "file_write", args });
      return { ok: true, content: "written" };
    },
  };
  registry.register(read);
  registry.register(grep);
  registry.register(write);
  return registry;
}

function makeCtx(workspace = WS): ToolContext {
  return {
    cfg: { policy: { sandboxMode: "workspace-write" } } as ToolContext["cfg"],
    workspace,
    emit: () => {},
    taskId: "task_cm_e2e",
    signal: new AbortController().signal,
  };
}

describe("codemode tool", () => {
  let tmpDir = "";
  let mod: typeof import("../tool.js");

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-codemode-tool-data-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    await import("../../server/sqliteStore.js");
    mod = await import("../tool.js");
    // Opt in for these tests; the switch itself is asserted separately below.
    const settings = await import("../../server/settings.js");
    settings.updateSettings({ codemode: true });
  });

  after(() => {
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(WS, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("refuses to run when codemode is disabled (opt-in)", async () => {
    const settings = await import("../../server/settings.js");
    settings.updateSettings({ codemode: false });
    try {
      const registry = makeRegistry();
      const tool = mod.createCodemodeTool({ registry, taskId: "task_cm_off", workspaceRoot: WS, sandboxMode: "workspace-write" });
      const result = await tool.run({ code: `return 1;` }, makeCtx());
      assert.equal(result.ok, false);
      assert.match(result.content, /disabled/);
      assert.equal(registry.calls.length, 0, "no tool may run while the sandbox is off");
    } finally {
      settings.updateSettings({ codemode: true });
    }
  });

  it("rejects an empty code argument", async () => {
    const registry = makeRegistry();
    const tool = mod.createCodemodeTool({ registry, taskId: "task_cm_empty", workspaceRoot: WS, sandboxMode: "workspace-write" });
    const result = await tool.run({ code: "   " }, makeCtx());
    assert.equal(result.ok, false);
    assert.match(result.content, /non-empty/);
  });

  it("runs a fan-out of read+grep calls and returns only a compact summary", async () => {
    const registry = makeRegistry();
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(WS, `f${i}.txt`), `needle in file ${i}\n`);

    const tool = mod.createCodemodeTool({ registry, taskId: "task_cm_e2e", workspaceRoot: WS, sandboxMode: "workspace-write" });
    const code = `
      const files = Array.from({ length: 20 }, (_, i) => "f" + i + ".txt");
      const contents = await Promise.all(files.map((f) => tools.file_read({ path: f })));
      const matches = await Promise.all(files.map(() => tools.grep({ pattern: "needle" })));
      return { read: contents.length, matched: matches.filter((m) => m.hits.length > 0).length, sample: contents[0].split("\\n")[0] };
    `;

    const result = await tool.run({ code }, makeCtx());
    assert.equal(result.ok, true, result.content);
    // Only the summary enters the transcript: the 20 read bodies and 20 grep
    // payloads never leave the sandbox.
    assert.ok(result.content.length < 2048, `transcript growth must stay under 2 KB, got ${result.content.length} chars`);
    assert.equal(registry.calls.length, 40, "the script made 20 reads and 20 greps");
    assert.deepEqual(returnedValue(result.content), { read: 20, matched: 20, sample: "needle in file 0" });
  });

  it("renders the summary plus the call count for the transcript", async () => {
    const registry = makeRegistry();
    fs.writeFileSync(path.join(WS, "f0.txt"), "needle in file 0\n");
    const tool = mod.createCodemodeTool({ registry, taskId: "task_cm_fmt", workspaceRoot: WS, sandboxMode: "workspace-write" });
    const result = await tool.run({ code: `await tools.file_read({ path: "f0.txt" }); return { ok: 1 };` }, makeCtx());
    assert.equal(result.ok, true, result.content);
    assert.match(result.content, /tool calls: 1/);
    assert.deepEqual(returnedValue(result.content), { ok: 1 });
  });

  it("reports a script failure without leaking intermediate tool output", async () => {
    const registry = makeRegistry();
    fs.writeFileSync(path.join(WS, "f0.txt"), "needle in file 0\n");
    const tool = mod.createCodemodeTool({ registry, taskId: "task_cm_err", workspaceRoot: WS, sandboxMode: "workspace-write" });
    const result = await tool.run({ code: `await tools.file_read({ path: "f0.txt" }); throw new Error("script exploded");` }, makeCtx());
    assert.equal(result.ok, true, "a script error is still a successful tool call");
    assert.match(result.content, /codemode failed/);
    assert.doesNotMatch(result.content, /needle in file 0/, "the tool output must not be echoed back");
  });

  it("enforces the code length cap", async () => {
    const registry = makeRegistry();
    const tool = mod.createCodemodeTool({ registry, taskId: "task_cm_cap", workspaceRoot: WS, sandboxMode: "workspace-write" });
    const result = await tool.run({ code: `return "${"x".repeat(mod.CODEMODE_MAX_CODE_CHARS)}";` }, makeCtx());
    assert.equal(result.ok, false);
    assert.match(result.content, /character limit/);
  });

  it("never exposes codemode itself to the script", async () => {
    const registry = makeRegistry();
    registry.register(mod.createUnboundCodemodeTool());
    const tool = mod.createCodemodeTool({ registry, taskId: "task_cm_nest", workspaceRoot: WS, sandboxMode: "workspace-write" });
    const result = await tool.run({ code: `return { self: "codemode" in tools, listed: listTools("codemode").length };` }, makeCtx());
    assert.deepEqual(returnedValue(result.content), { self: false, listed: 0 }, "a script must not nest sandboxes");
  });

  it("routes a call through the policy gate before it reaches the registry", async () => {
    const registry = makeRegistry();
    const tool = mod.createCodemodeTool({ registry, taskId: "task_cm_deny", workspaceRoot: WS, sandboxMode: "read-only" });
    const result = await tool.run(
      { code: `try { await tools.file_write({ path: "out.txt", content: "x" }); return "allowed"; } catch (e) { return "refused"; }` },
      makeCtx(),
    );
    assert.deepEqual(returnedValue(result.content), "refused");
    assert.equal(registry.calls.length, 0, "a policy-denied call must never reach the registry");
  });

  it("surfaces a real tool failure to the script as a thrown error", async () => {
    const registry = makeRegistry();
    const tool = mod.createCodemodeTool({ registry, taskId: "task_cm_fail", workspaceRoot: WS, sandboxMode: "workspace-write" });
    const result = await tool.run(
      { code: `try { await tools.file_read({ path: "missing.txt" }); return "no"; } catch (e) { return "threw"; }` },
      makeCtx(),
    );
    assert.deepEqual(returnedValue(result.content), "threw");
    assert.equal(registry.calls.length, 1);
  });

  it("keeps the unbound stub inert", async () => {
    const stub = mod.createUnboundCodemodeTool();
    assert.equal(stub.name, "codemode");
    const result = await stub.run({ code: `return 1;` }, makeCtx());
    assert.equal(result.ok, false);
    assert.match(result.content, /not bound/);
  });

  it("resolves settings from the config default with sane limits", () => {
    const settings = mod.resolveCodemodeSettings();
    assert.equal(settings.enabled, true, "the test opted in");
    assert.ok(settings.timeoutMs > 0);
    assert.ok(settings.memoryBytes >= 1024 * 1024);
    assert.ok(settings.maxToolCalls > 0);
  });

  it("documents the tool surface the model sees", () => {
    const tool = mod.createCodemodeTool({ registry: makeRegistry(), taskId: "task_cm_desc", workspaceRoot: WS, sandboxMode: "workspace-write" });
    assert.equal(tool.name, "codemode");
    assert.match(tool.description, /tools\.<name>\(args\)/);
    assert.equal((tool.parameters as { required?: string[] }).required?.[0], "code");
  });
});
