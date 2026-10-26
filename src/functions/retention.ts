import { retentionScore, type RetrievableEntry } from "../memory/hybrid.js";

export interface RetentionPolicy {
  /** Evict agent-sourced non-preference unused this many days (D-D1 / OD-M-E1). */
  unusedDays: number;
  softDeleteDays: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = { unusedDays: 30, softDeleteDays: 7 };

export interface EvictionCandidate {
  id: string;
  reason: "unused_agent_non_preference";
  retention: ReturnType<typeof retentionScore>;
}

export function planEvictions(entries: RetrievableEntry[], policy = DEFAULT_RETENTION_POLICY, now = Date.now()): EvictionCandidate[] {
  const day = 86_400_000;
  const out: EvictionCandidate[] = [];
  for (const e of entries) {
    if (e.source !== "agent") continue;
    if (e.kind === "preference") continue;
    const last = Date.parse(e.lastUsedAt ?? e.createdAt);
    const unused = (now - last) / day;
    const r = retentionScore(e, now);
    if (unused >= policy.unusedDays && r.tier === "evictable") {
      out.push({ id: e.id, reason: "unused_agent_non_preference", retention: r });
    }
  }
  return out;
}
