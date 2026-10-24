/**
 * Smoke check for verbatim context pruning: a fixed transcript must shrink by
 * at least `minReduction`, never orphan a tool message, keep untouched
 * messages by identity, and leave every omitted body recallable.
 */
import type { ChatMessage } from "../ollama.js";
import { pruneTranscript } from "../agent/prune/index.js";
import { DEFAULT_PRUNE_CONFIG } from "../agent/prune/config.js";
import { HeuristicScorer } from "../agent/prune/heuristicScorer.js";
import { PrunedStore } from "../agent/prune/prunedStore.js";
import { contextRecallTool } from "../tools/contextRecallTool.js";
import type { ToolContext } from "../tools/registry.js";
import type { ToolMeta } from "../agent/prune/types.js";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
}

const call = (path: string): ChatMessage =>
  ({ role: "assistant", content: "", tool_calls: [{ function: { name: "file_read", arguments: { path } } }] });
const result = (body: string): ChatMessage => ({ role: "tool", tool_name: "file_read", content: body });

const messages: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "fix a.ts" },
  { role: "assistant", content: "ok" },
];
for (let i = 0; i < 8; i++) messages.push(call("a.ts"), result(String.fromCharCode(65 + i).repeat(12000)));
messages.push({ role: "user", content: "next" }, { role: "assistant", content: "done" });

const cfg = { ...DEFAULT_PRUNE_CONFIG, preserveRecent: 1 };
const store = new PrunedStore();
const scorer = new HeuristicScorer();
const run = await pruneTranscript(messages, {
  cfg, goal: "fix a.ts", todos: [], meta: new Map<ChatMessage, ToolMeta>(), scorer, fallback: scorer, store,
});

console.log("context prune smoke");
check("pruning applied", run.applied, run.reason);
check(
  `reduction >= ${cfg.minReduction}`,
  run.stats.charsAfter / run.stats.charsBefore <= 1 - cfg.minReduction,
  `${run.stats.charsBefore} -> ${run.stats.charsAfter}`,
);
check(
  "no orphan tool messages",
  run.messages.every((m, i) => {
    if (m.role !== "tool") return true;
    let j = i - 1;
    while (j >= 0 && run.messages[j]!.role === "tool") j--;
    return j >= 0 && (run.messages[j]!.tool_calls?.length ?? 0) > 0;
  }),
);
check("system and user messages kept by identity", run.messages[0] === messages[0] && run.messages[1] === messages[1]);
check("omitted bodies stored", store.size > 0);

const firstId = /context_recall with id="([^"]+)"/.exec(run.messages.map((m) => m.content).join("\n"))?.[1];
check("stub names a recall id", Boolean(firstId));
if (firstId) {
  const recalled = await contextRecallTool().run({ id: firstId }, { cfg: {}, workspace: ".", emit: () => {}, prunedStore: store } as unknown as ToolContext);
  check("context_recall returns the body", recalled.ok && recalled.content.includes("UNTRUSTED EXTERNAL CONTENT"));
}

console.log(failed === 0 ? "context prune smoke: PASS" : `context prune smoke: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
