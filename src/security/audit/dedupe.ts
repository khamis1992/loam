/**
 * Candidate de-duplication. A deterministic pass runs first (same file, same normalised title), then an
 * optional model judge looks at pairs that share a file or that the critic proposed to merge.
 * The judge fails open: any failure means "not a duplicate". Nothing is deleted silently; the lesser
 * candidate goes into the inferior-dupe map with the one that supersedes it and why.
 */
import { runAgentJson } from "./agentIO.js";
import type { AgentDeps } from "./agentIO.js";
import { confidenceOf } from "./fpFilter.js";
import type { Candidate } from "./fpFilter.js";
import { dedupePrompt } from "./prompts.js";
import { text } from "./schema.js";
import type { SchemaObject } from "./schema.js";

const obj = (properties: Record<string, SchemaObject>, required: string[]): SchemaObject => ({
  type: "object", properties, required, additionalProperties: false,
});
const arr = (items: SchemaObject): SchemaObject => ({ type: "array", items, minItems: 0 });
const bool = (): SchemaObject => ({ type: "boolean" });

export interface DupeEntry { superseded_by: string; by: "deterministic" | "judge"; reason: string }
export type InferiorDupeMap = Record<string, DupeEntry>;

export interface DedupeResult {
  kept: Candidate[];
  map: InferiorDupeMap;
  /** Why the judge did not decide, one line each. Empty when it ran cleanly or had nothing to judge. */
  judgeFailures: string[];
}

const MAX_JUDGE_PAIRS = 20;

const fileOf = (c: Candidate): string => c.primary_file ?? c.trace[0]?.file ?? c.evidence[0]?.file ?? "";
const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Better candidate first: confirmed, then higher confidence, then more evidence, then a stable tiebreak. */
function better(a: Candidate, b: Candidate): Candidate {
  const rank = (c: Candidate): number[] => [c.verdict === "confirmed" ? 1 : 0, confidenceOf(c), c.evidence.length];
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! > rb[i]! ? a : b;
  return a.fingerprint <= b.fingerprint ? a : b;
}

/** Same primary file and same normalised title: the same claim reported twice. */
export function dedupeDeterministic(cands: Candidate[], map: InferiorDupeMap = {}): { kept: Candidate[]; map: InferiorDupeMap } {
  const winners = new Map<string, Candidate>();
  for (const c of cands) {
    const key = `${fileOf(c)}\u0000${norm(c.title)}`;
    const w = winners.get(key);
    if (!w) { winners.set(key, c); continue; }
    const keep = better(w, c);
    const lose = keep === w ? c : w;
    if (lose.fingerprint !== keep.fingerprint) {
      map[lose.fingerprint] = { superseded_by: keep.fingerprint, by: "deterministic", reason: "same file and same title" };
    }
    winners.set(key, keep);
  }
  const keepSet = new Set([...winners.values()].map((c) => c.fingerprint));
  const seen = new Set<string>();
  const kept = cands.filter((c) => {
    if (!keepSet.has(c.fingerprint) || seen.has(c.fingerprint)) return false;
    seen.add(c.fingerprint);
    return true;
  });
  return { kept, map };
}

const JUDGE_SCHEMA = obj({
  verdicts: arr(obj({ a: text(), b: text(), duplicate: bool(), keep: text(), reason: text() }, ["a", "b", "duplicate", "keep", "reason"])),
}, ["verdicts"]);

/** Pairs worth asking about: same file but different titles, plus any the critic proposed. */
export function judgePairs(cands: Candidate[], criticPairs: string[][] = []): Array<[Candidate, Candidate]> {
  const byFp = new Map(cands.map((c) => [c.fingerprint, c]));
  const out: Array<[Candidate, Candidate]> = [];
  const seen = new Set<string>();
  const add = (a: Candidate | undefined, b: Candidate | undefined): void => {
    if (!a || !b || a.fingerprint === b.fingerprint) return;
    const k = [a.fingerprint, b.fingerprint].sort().join("|");
    if (seen.has(k) || out.length >= MAX_JUDGE_PAIRS) return;
    seen.add(k);
    out.push([a, b]);
  };
  for (const p of criticPairs) add(byFp.get(p[0] ?? ""), byFp.get(p[1] ?? ""));
  const byFile = new Map<string, Candidate[]>();
  for (const c of cands) {
    const f = fileOf(c);
    if (f) byFile.set(f, [...(byFile.get(f) ?? []), c]);
  }
  for (const group of byFile.values()) {
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) add(group[i], group[j]);
  }
  return out;
}

const brief = (c: Candidate) => ({
  fingerprint: c.fingerprint, title: c.title.slice(0, 160), file: fileOf(c),
  line: c.trace[c.trace.length - 1]?.line ?? c.evidence[0]?.line ?? 0, root_cause: ("root_cause" in c ? c.root_cause : c.claimed_root_cause).slice(0, 240),
});

/**
 * Ask the model whether pairs are the same weakness. The role, not a pinned model name, decides which
 * model answers. Any failure leaves every candidate in place and is reported in `judgeFailures`.
 */
export async function judgeDuplicates(
  deps: AgentDeps, cands: Candidate[], criticPairs: string[][] = [], map: InferiorDupeMap = {},
): Promise<DedupeResult> {
  const pairs = judgePairs(cands, criticPairs);
  if (pairs.length === 0) return { kept: cands, map, judgeFailures: [] };
  const payload = JSON.stringify(pairs.map(([a, b]) => ({ a: brief(a), b: brief(b) })));
  const o = await runAgentJson<{ verdicts: Array<{ a: string; b: string; duplicate: boolean; keep: string; reason: string }> }>(
    deps, { role: "audit-research", prompt: dedupePrompt(payload), schema: JUDGE_SCHEMA },
  );
  if (!o.ok) return { kept: cands, map, judgeFailures: [o.reason] };
  const known = new Set(pairs.flatMap(([a, b]) => [`${a.fingerprint}|${b.fingerprint}`, `${b.fingerprint}|${a.fingerprint}`]));
  const dropped = new Set<string>();
  for (const v of o.value.verdicts) {
    // Only pairs we asked about, only when both are still standing, and keep must be one of the two.
    if (!v.duplicate || !known.has(`${v.a}|${v.b}`) || (v.keep !== v.a && v.keep !== v.b)) continue;
    const lose = v.keep === v.a ? v.b : v.a;
    if (dropped.has(v.a) || dropped.has(v.b) || map[lose]) continue;
    dropped.add(lose);
    map[lose] = { superseded_by: v.keep, by: "judge", reason: v.reason.slice(0, 240) };
  }
  return { kept: cands.filter((c) => !dropped.has(c.fingerprint)), map, judgeFailures: [] };
}
