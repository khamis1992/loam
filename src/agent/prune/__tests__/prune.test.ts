import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "../../../ollama.js";
import type { PairScore, PruneConfig, PruneScorer, ScorerInput, ToolMeta } from "../types.js";
import { ScorerError } from "../types.js";
import { PrunedStore } from "../prunedStore.js";
import { pruneTranscript } from "../index.js";
import { HeuristicScorer } from "../heuristicScorer.js";

const cfg: PruneConfig = {
  strategy: "prune", scorer: "heuristic", model: "", keepThreshold: 0.5, preserveRecent: 2, headChars: 40,
  minReduction: 0.15, maxStateTokens: 8000, maxRequestTokens: 8000, pinnedTools: ["todo_write"], sideEffectTools: [],
};
const none = new Map<string, never>() as unknown as ReadonlyMap<ChatMessage, ToolMeta>;
const asst = (content: string, name: string, args: unknown = {}): ChatMessage =>
  ({ role: "assistant", content, tool_calls: [{ function: { name, arguments: args } }] });
const tool = (name: string, content: string): ChatMessage => ({ role: "tool", tool_name: name, content });
const heur = new HeuristicScorer();

function transcript(): ChatMessage[] {
  return [
    { role: "user", content: "fix the bug" },
    asst("", "file_read", { path: "a.ts" }), tool("file_read", "A".repeat(3000)),
    asst("", "file_read", { path: "a.ts" }), tool("file_read", "B".repeat(3000)),
    { role: "user", content: "u1" }, { role: "user", content: "u2" },
  ];
}
const ctx = (store: PrunedStore, over: object = {}) =>
  ({ cfg, goal: "fix the bug", todos: [], meta: none, scorer: heur, fallback: heur, store, ...over });

test("store returns the exact body, evicts oldest by count and by chars", () => {
  const s = new PrunedStore(2, 100);
  s.put("a", "file_read", "x".repeat(40));
  s.put("b", "file_read", "y".repeat(40));
  assert.equal(s.get("a")!.body, "x".repeat(40));
  s.put("c", "file_read", "z".repeat(40));
  assert.equal(s.size, 2);
  assert.equal(s.get("b"), undefined);
  assert.ok(s.totalChars <= 100);
  s.put("a", "file_read", "w");
  assert.equal(s.get("a")!.body, "w");
  assert.equal(s.totalChars, 41);
});

test("store never keeps the body of a secret tool", () => {
  const s = new PrunedStore();
  s.put("k", "secrets_read", "hunter2");
  assert.equal(s.get("k"), undefined);
  assert.equal(s.size, 0);
});

test("pruneTranscript drops the superseded read and recall returns it verbatim", async () => {
  const store = new PrunedStore();
  const msgs = transcript();
  const r = await pruneTranscript(msgs, ctx(store));
  assert.equal(r.applied, true);
  assert.ok(r.stats.charsAfter < r.stats.charsBefore);
  assert.equal(r.stats.dropped, 1);
  const id = r.decisions.find(d => d.action === "drop_call")!.id;
  assert.equal(store.get(id)!.body, "A".repeat(3000));
  assert.equal(r.messages.length, msgs.length - 2);
});

test("insufficient reduction leaves the transcript unchanged but keeps stored bodies", async () => {
  const store = new PrunedStore();
  const r = await pruneTranscript(transcript(), ctx(store, { cfg: { ...cfg, minReduction: 0.99 } }));
  assert.equal(r.applied, false);
  assert.equal(r.reason, "insufficient reduction");
  assert.equal(r.messages.length, 7);
  assert.equal(store.size, 2);
});

test("nothing to prune when every pair is pinned", async () => {
  const msgs: ChatMessage[] = [{ role: "user", content: "g" }, asst("", "todo_write"), tool("todo_write", "t".repeat(500)), { role: "user", content: "a" }, { role: "user", content: "b" }];
  const r = await pruneTranscript(msgs, ctx(new PrunedStore()));
  assert.deepEqual([r.applied, r.reason], [false, "nothing to prune"]);
});

test("a throwing or incomplete scorer falls back to the heuristic", async () => {
  const boom: PruneScorer = { name: "model", async score() { throw new ScorerError("bad"); } };
  const partial: PruneScorer = { name: "model", async score(i: ScorerInput) { return new Map<string, PairScore>([[i.pairs[0]!.id, { keepCall: 1, keepResult: 1 }]]); } };
  for (const scorer of [boom, partial]) {
    const r = await pruneTranscript(transcript(), ctx(new PrunedStore(), { scorer }));
    assert.equal(r.stats.fallback, true);
    assert.equal(r.stats.scorer, "heuristic");
    assert.equal(r.applied, true);
  }
});

test("an aborted run rethrows the scorer error", async () => {
  const ac = new AbortController();
  ac.abort();
  const boom: PruneScorer = { name: "model", async score() { throw new Error("aborted"); } };
  await assert.rejects(pruneTranscript(transcript(), ctx(new PrunedStore(), { scorer: boom, signal: ac.signal })));
});

test("the input array and message objects are not mutated", async () => {
  const msgs = transcript();
  const snap = JSON.stringify(msgs);
  await pruneTranscript(msgs, ctx(new PrunedStore()));
  assert.equal(JSON.stringify(msgs), snap);
});
