import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import type { Config } from "../../../config.js";
import type { ChatMessage, ChatResult, OllamaClient } from "../../../ollama.js";
import type { AgentEvent, Emit } from "../../events.js";
import { compressContext } from "../../contextCompressor.js";
import { DEFAULT_PRUNE_CONFIG } from "../config.js";
import { PrunedStore } from "../prunedStore.js";
import type { PruneConfig, ToolMeta } from "../types.js";

function makeConfig(prune?: PruneConfig): Config {
  return {
    model: "qwen2.5:14b",
    fallbackModel: "qwen2.5:7b",
    ollamaUrl: "http://localhost:11434",
    agent: { maxSteps: 40, temperature: 0.2, requestTimeoutMs: 600000 },
    workspace: os.tmpdir(),
    mcpServers: {},
    compression: {
      enabled: true, thresholdPercent: 0.5, protectLead: 3, protectTail: 2, targetRatio: 0.2, bufferTokens: 20000,
      reattachFiles: 0, reattachFileChars: 4000, criticalThresholdPercent: 0.95, recentTurnsToKeep: 10, minTurnsToKeep: 2,
      emergencyToolResultMaxChars: 4000, model: "", contextWindow: { "qwen2.5": 32768 },
      ...(prune ? { prune } : {}),
    },
  } as unknown as Config;
}

function makeOllama() {
  let calls = 0;
  const ollama = {
    async chat(): Promise<ChatResult> {
      calls++;
      return { content: "summary text", toolCalls: [], model: "m", usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
    },
  } as unknown as OllamaClient;
  return { ollama, calls: () => calls };
}

function makeEmit() {
  const events: AgentEvent[] = [];
  return { emit: ((e: AgentEvent) => events.push(e)) as Emit, events };
}

const call = (path: string): ChatMessage =>
  ({ role: "assistant", content: "", tool_calls: [{ function: { name: "file_read", arguments: { path } } }] });
const result = (body: string): ChatMessage => ({ role: "tool", tool_name: "file_read", content: body });

/** Six reads of one file (about 3,000 tokens each): over the 16k trigger, far under the critical line. */
function transcript(withProse = false): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "fix a.ts" }, { role: "assistant", content: "ok" }];
  // Prose neither step 1 nor pruning can remove, so only the summary gets under the threshold.
  // It goes ahead of the reads so it lands in the middle, not the protected tail.
  if (withProse) for (let i = 0; i < 3; i++) out.push({ role: "assistant", content: `note ${i} ` + "w".repeat(27000) });
  for (let i = 0; i < (withProse ? 3 : 6); i++) out.push(call("a.ts"), result(String.fromCharCode(65 + i).repeat(12000)));
  out.push({ role: "user", content: "next" }, { role: "assistant", content: "done" });
  return out;
}

const prune = (over: Partial<PruneConfig> = {}): PruneConfig => ({ ...DEFAULT_PRUNE_CONFIG, preserveRecent: 1, ...over });
const meta = new Map<ChatMessage, ToolMeta>();

function noOrphans(messages: ChatMessage[]): boolean {
  return messages.every((m, i) => {
    if (m.role !== "tool") return true;
    let j = i - 1;
    while (j >= 0 && messages[j]!.role === "tool") j--;
    return j >= 0 && (messages[j]!.tool_calls?.length ?? 0) > 0;
  });
}

test("prune_then_summary prunes verbatim, emits context_pruned and skips the summarizer", async () => {
  const { ollama, calls } = makeOllama();
  const { emit, events } = makeEmit();
  const store = new PrunedStore();
  const msgs = transcript();
  const r = await compressContext(makeConfig(prune()), ollama, msgs, emit, undefined, { toolMeta: meta, prunedStore: store, goal: "fix a.ts" });
  assert.equal(r.compressed, true);
  assert.equal(r.step, 1);
  assert.equal(calls(), 0);
  assert.ok(r.messages.length < msgs.length);
  assert.ok(noOrphans(r.messages));
  assert.ok(store.size > 0);
  const pruned = events.find((e) => e.type === "context_pruned");
  assert.ok(pruned && pruned.type === "context_pruned");
  assert.ok(pruned.charsAfter < pruned.charsBefore);
  assert.ok(pruned.tokensAfter < pruned.tokensBefore);
  assert.equal(pruned.scorer, "heuristic");
  assert.ok(events.some((e) => e.type === "compaction" && e.step === 1));
});

test("strategy summary, a missing block, or missing inputs keep today's behaviour", async () => {
  const cases: Array<[string, Config, object]> = [
    ["summary", makeConfig(prune({ strategy: "summary" })), { toolMeta: meta, prunedStore: new PrunedStore() }],
    ["no block", makeConfig(), { toolMeta: meta, prunedStore: new PrunedStore() }],
    ["no meta", makeConfig(prune()), { prunedStore: new PrunedStore() }],
    ["no store", makeConfig(prune()), { toolMeta: meta }],
  ];
  for (const [name, cfg, extra] of cases) {
    const { ollama, calls } = makeOllama();
    const { emit, events } = makeEmit();
    const r = await compressContext(cfg, ollama, transcript(), emit, undefined, extra);
    assert.equal(r.step, 1, name);
    assert.equal(calls(), 0, name);
    assert.ok(!events.some((e) => e.type === "context_pruned"), name);
    const withProse = await compressContext(cfg, makeOllama().ollama, transcript(true), makeEmit().emit, undefined, extra);
    assert.equal(withProse.step, 2, name);
  }
});

test("strategy prune never calls the summarizer, even when still over the threshold", async () => {
  const { ollama, calls } = makeOllama();
  const { emit } = makeEmit();
  const msgs = transcript();
  const r = await compressContext(
    makeConfig(prune({ strategy: "prune", minReduction: 0.01 })), ollama, msgs, emit, undefined,
    { toolMeta: meta, prunedStore: new PrunedStore(), goal: "fix a.ts" },
  );
  assert.equal(calls(), 0);
  assert.equal(r.step, 1);
  assert.ok(noOrphans(r.messages));
});

test("an unreachable reduction leaves the old flow untouched", async () => {
  const { ollama, calls } = makeOllama();
  const { emit, events } = makeEmit();
  const r = await compressContext(
    makeConfig(prune({ minReduction: 0.9 })), ollama, transcript(true), emit, undefined,
    { toolMeta: meta, prunedStore: new PrunedStore(), goal: "fix a.ts" },
  );
  assert.equal(calls(), 1);
  assert.equal(r.step, 2);
  assert.ok(!events.some((e) => e.type === "context_pruned"));
});

test("prune_then_summary prunes first and still summarizes when prose keeps it over the threshold", async () => {
  const { ollama, calls } = makeOllama();
  const { emit, events } = makeEmit();
  const r = await compressContext(
    makeConfig(prune()), ollama, transcript(true), emit, undefined,
    { toolMeta: meta, prunedStore: new PrunedStore(), goal: "fix a.ts" },
  );
  assert.ok(events.some((e) => e.type === "context_pruned"));
  assert.equal(calls(), 1);
  assert.equal(r.step, 2);
  assert.ok(noOrphans(r.messages));
});
