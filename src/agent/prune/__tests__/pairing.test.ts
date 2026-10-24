import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "../../../ollama.js";
import type { ToolMeta } from "../types.js";
import { collectPairs } from "../pairing.js";

const call = (name: string): { function: { name: string; arguments: unknown } } => ({ function: { name, arguments: { n: name } } });
const asst = (...names: string[]): ChatMessage => ({ role: "assistant", content: "", tool_calls: names.map(call) });
const tool = (name: string, content = "x".repeat(50)): ChatMessage => ({ role: "tool", tool_name: name, content });
const none = new Map<ChatMessage, ToolMeta>();
const opts = { protectLead: 1, preserveRecent: 2, pinnedTools: new Set<string>() };

test("pairs N calls with the next N tool messages in order", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "go" },
    asst("a", "b"), tool("a"), tool("b"),
    { role: "user", content: "u1" }, { role: "user", content: "u2" },
  ];
  const pairs = collectPairs(msgs, none, opts);
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs.map(p => [p.tool, p.assistantIndex, p.callIndex, p.toolIndex]), [["a", 1, 0, 2], ["b", 1, 1, 3]]);
  assert.ok(pairs.every(p => !p.pinned));
  assert.equal(pairs[0]!.id, "p1_0");
});

test("a count mismatch pins every pair of that assistant message", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "go" },
    asst("a", "b"), tool("a"),
    { role: "user", content: "u1" }, { role: "user", content: "u2" }, { role: "user", content: "u3" },
  ];
  const pairs = collectPairs(msgs, none, opts);
  assert.equal(pairs.length, 2);
  assert.ok(pairs.every(p => p.pinned));
  assert.equal(pairs[1]!.toolIndex, -1);
});

test("surplus tool messages also pin the group", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "go" }, asst("a"), tool("a"), tool("b"),
    { role: "user", content: "u1" }, { role: "user", content: "u2" }, { role: "user", content: "u3" },
  ];
  assert.ok(collectPairs(msgs, none, opts).every(p => p.pinned));
});

test("lead and recent zones, and pinned tools, are pinned", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "go" },
    asst("todo_write"), tool("todo_write"),
    asst("a"), tool("a"),
    { role: "user", content: "u1" },
    asst("b"), tool("b"),
  ];
  const pairs = collectPairs(msgs, none, { protectLead: 4, preserveRecent: 2, pinnedTools: new Set(["todo_write"]) });
  assert.deepEqual(pairs.map(p => p.pinned), [true, true, true]);
  const loose = collectPairs(msgs, none, { protectLead: 1, preserveRecent: 2, pinnedTools: new Set(["todo_write"]) });
  assert.deepEqual(loose.map(p => p.pinned), [true, false, true]);
});

test("meta supplies id, ok and path; duplicate ids fall back to positional", () => {
  const t1 = tool("a"), t2 = tool("a");
  const msgs: ChatMessage[] = [
    { role: "user", content: "go" }, asst("a"), t1, asst("a"), t2,
    { role: "user", content: "u1" }, { role: "user", content: "u2" },
  ];
  const meta = new Map<ChatMessage, ToolMeta>([
    [t1, { callId: "c1", ok: false, args: {}, path: "src/a.ts" }],
    [t2, { callId: "c1", ok: true, args: {} }],
  ]);
  const pairs = collectPairs(msgs, meta, opts);
  assert.deepEqual(pairs.map(p => p.id), ["c1", "p3_0"]);
  assert.equal(pairs[0]!.ok, false);
  assert.equal(pairs[0]!.path, "src/a.ts");
  assert.equal(pairs[0]!.stepsAgo, 1);
  assert.equal(pairs[1]!.stepsAgo, 0);
});
