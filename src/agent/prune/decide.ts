import type { PairScore, PruneDecision, ToolPair } from "./types.js";

export function decide(pair: ToolPair, s: PairScore, keepThreshold: number): PruneDecision {
  if (pair.pinned) return { id: pair.id, tool: pair.tool, ...s, action: "keep", reason: "pinned" };
  if (s.keepResult >= keepThreshold) return { id: pair.id, tool: pair.tool, ...s, action: "keep", reason: "kept" };
  if (s.keepCall >= keepThreshold) return { id: pair.id, tool: pair.tool, ...s, action: "truncate_result", reason: "result_truncated" };
  return { id: pair.id, tool: pair.tool, ...s, action: "drop_call", reason: "call_dropped" };
}
