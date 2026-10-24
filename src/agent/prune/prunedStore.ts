import { BoundedMap } from "../../memory/cache.js";
import { classifyToolCall } from "../../policy/riskTier.js";
import type { PrunedSink } from "./types.js";

interface Entry { tool: string; body: string }

/**
 * Per-run, in-memory home for bodies removed by pruning, so `context_recall` can return
 * them verbatim. Bounded by entry count and total characters (oldest evicted first).
 * Never persisted. Bodies of tools classified "secret" are not kept at all.
 */
export class PrunedStore implements PrunedSink {
  private readonly entries: BoundedMap<string, Entry>;
  private chars = 0;

  constructor(private readonly maxEntries = 256, private readonly maxChars = 4_000_000) {
    this.entries = new BoundedMap<string, Entry>(maxEntries, "prunedStore", (_k, v) => {
      this.chars -= v.body.length;
    });
  }

  get size(): number { return this.entries.size; }
  get totalChars(): number { return this.chars; }

  put(id: string, tool: string, body: string): void {
    if (this.maxEntries <= 0 || this.maxChars <= 0) return;
    if (classifyToolCall(tool) === "secret") return;
    const prev = this.entries.get(id);
    if (prev) {
      this.entries.delete(id);
      this.chars -= prev.body.length;
    }
    const kept = body.length > this.maxChars ? body.slice(0, this.maxChars) : body;
    while (this.chars + kept.length > this.maxChars && this.entries.evictOldest()) { /* make room */ }
    this.entries.set(id, { tool, body: kept });
    this.chars += kept.length;
  }

  get(id: string): { tool: string; body: string } | undefined {
    return this.entries.get(id);
  }
}
