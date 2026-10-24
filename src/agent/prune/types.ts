import type { ChatMessage } from "../../ollama.js";

export interface ToolMeta { callId: string; ok: boolean; args: unknown; path?: string }

export interface ToolPair {
  id: string;              // meta.callId when known, else `p${assistantIndex}_${callIndex}`
  assistantIndex: number;  // index in messages
  callIndex: number;       // index inside tool_calls
  toolIndex: number;       // index of the matching tool message, -1 when missing
  tool: string;
  argsJson: string;        // JSON.stringify(arguments), uncapped (capped only in state)
  resultChars: number;
  ok: boolean;             // from ToolMeta; true when unknown
  path?: string;
  stepsAgo: number;
  pinned: boolean;
}

export interface PairScore { keepCall: number; keepResult: number } // each in [0,1]
export type PruneAction = "keep" | "truncate_result" | "drop_call";
export interface PruneDecision extends PairScore {
  id: string;
  tool: string;
  action: PruneAction;
  reason: "pinned" | "kept" | "result_truncated" | "call_dropped";
}

export interface ScorerInput {
  goal: string;
  query: string;
  pairs: ToolPair[];
  bodies: ReadonlyMap<string, string>;
  laterAssistantText: (pairId: string) => string;
  state?: string;
}
export interface PruneScorer {
  readonly name: string;
  score(input: ScorerInput, signal?: AbortSignal): Promise<Map<string, PairScore>>;
}
export class ScorerError extends Error {}

export interface PruneConfig {
  strategy: "summary" | "prune" | "prune_then_summary";
  scorer: "heuristic" | "model";
  model: string;
  keepThreshold: number;
  preserveRecent: number;
  headChars: number;
  minReduction: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  pinnedTools: string[];
  sideEffectTools: string[];
}

export interface PruneStats {
  charsBefore: number; charsAfter: number; kept: number; truncated: number; dropped: number;
  pinned: number; scorer: string; fallback: boolean; requests: number;
}
export interface PruneResult { applied: boolean; reason: string; messages: ChatMessage[]; decisions: PruneDecision[]; stats: PruneStats }

/** Where non-kept bodies are saved before removal. The per-run PrunedStore satisfies it. */
export interface PrunedSink { put(id: string, tool: string, body: string): void }
