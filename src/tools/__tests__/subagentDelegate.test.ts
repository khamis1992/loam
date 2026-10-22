import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSubagentTools } from "../subagents.js";
import { ToolRegistry } from "../registry.js";
import type { OllamaClient } from "../../ollama.js";
import type { Config } from "../../config.js";
import { registry as subagentRegistry } from "../../subagent/registry.js";
import { EventQueue } from "../../subagent/eventQueue.js";
import type { SubagentEvent, SubagentProvider, SubagentResult, SubagentStartOptions } from "../../subagent/types.js";

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "loam-delegate-"));
const delegate = createSubagentTools({} as OllamaClient, new ToolRegistry()).find((t) => t.name === "delegate_task")!;

function cfgWith(over: Partial<{ maxDepth: number; maxConcurrentChildren: number }> = {}): Config {
  return {
    workspace: WORKSPACE,
    subagent: { maxDepth: over.maxDepth ?? 2, maxConcurrentChildren: over.maxConcurrentChildren ?? 4 },
  } as unknown as Config;
}

const state = { active: 0, peak: 0, started: 0, lastDepth: -1 };
const fakeProvider: SubagentProvider = {
  name: "in-process",
  async start(opts: SubagentStartOptions) {
    state.started += 1;
    state.lastDepth = opts.depth ?? 0;
    state.active += 1;
    state.peak = Math.max(state.peak, state.active);
    const events = new EventQueue<SubagentEvent>();
    let resolve!: (r: SubagentResult) => void;
    const resultPromise = new Promise<SubagentResult>((r) => {
      resolve = r;
    });
    setTimeout(() => {
      state.active -= 1;
      events.close();
      resolve({ stopReason: "completed", text: `child-${state.started}` });
    }, 25);
    return {
      id: "fake",
      events,
      result: () => resultPromise,
      cancel() {
        state.active -= 1;
        events.close();
        resolve({ stopReason: "cancelled", text: "" });
      },
    };
  },
};
subagentRegistry.register("in-process", fakeProvider);

test("delegate_task rejects a cwd outside the workspace", async () => {
  const res = await delegate.run(
    { provider: "in-process", prompt: "x", cwd: os.tmpdir() },
    { cfg: cfgWith(), workspace: WORKSPACE, emit: () => {} },
  );
  assert.equal(res.ok, false);
  assert.match(res.content, /within workspace/);
});

test("delegate_task enforces the depth limit before starting a provider", async () => {
  const before = state.started;
  const res = await delegate.run(
    { provider: "in-process", prompt: "x", cwd: WORKSPACE },
    { cfg: cfgWith({ maxDepth: 1 }), workspace: WORKSPACE, emit: () => {}, depth: 1 },
  );
  assert.equal(res.ok, false);
  assert.match(res.content, /depth limit 1 reached/);
  assert.equal(state.started, before, "provider must not start past the depth limit");
});

test("delegate_task returns the child text and passes depth + 1", async () => {
  const res = await delegate.run(
    { provider: "in-process", prompt: "x", cwd: WORKSPACE },
    { cfg: cfgWith(), workspace: WORKSPACE, emit: () => {}, depth: 0 },
  );
  assert.equal(res.ok, true);
  assert.match(res.content, /child-/);
  assert.equal(state.lastDepth, 1);
});

test("delegate_task bounds concurrent children to the configured maximum", async () => {
  state.peak = 0;
  state.active = 0;
  const before = state.started;
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      delegate.run(
        { provider: "in-process", prompt: "x", cwd: WORKSPACE },
        { cfg: cfgWith({ maxConcurrentChildren: 2 }), workspace: WORKSPACE, emit: () => {} },
      ),
    ),
  );
  assert.ok(results.every((r) => r.ok), results.map((r) => r.content).join("\n"));
  assert.equal(state.started, before + 6);
  assert.ok(state.peak >= 2, `expected the bound to be reached, peak=${state.peak}`);
  assert.ok(state.peak <= 2, `concurrency exceeded the bound, peak=${state.peak}`);
});
