/**
 * C3: pick the best of N candidates (fanout branches, App Builder Race
 * entrants, vuln-fix attempts, workflow vote nodes).
 *
 * Pipeline order from trae-agent's patch selector (MIT;
 * evaluation/patch_selection/trae_selector/selector_evaluation.py:172-250):
 *   1. regression prune, keeping all when none passes;
 *   2. dedup by a cleaned diff (added/removed lines only, utils.py:33);
 *   3. a selector judge run up to V times, stopping once one id has > V/2 votes.
 * Loam additions: duplicate-group size is kept as a consensus signal and is
 * the fallback when no cloud judge is available; judge output is a C6 contract.
 */
import { createHash } from "node:crypto";
import { callStructured } from "../contracts/structured.js";
import type { JsonSchema } from "../contracts/schema.js";
import type { ModelPort } from "../modelPort.js";

export interface Candidate {
  id: string;
  label?: string;
  ok: boolean;
  /** Final report text of the branch. */
  text: string;
  /** Unified diff of the branch's workspace changes, when it edited files. */
  diff?: string;
}

export interface CheckResult {
  passed: boolean;
  detail: string;
}
export type CandidateCheck = (c: Candidate) => Promise<CheckResult>;

export interface Judge {
  port: ModelPort;
  model: string;
  /** Number of judge runs for the vote (trae runs up to N; Loam default 3). */
  votes: number;
  repairAttempts: number;
}

export interface SelectInput {
  goal: string;
  candidates: Candidate[];
  maxCandidates: number;
  check?: CandidateCheck;
  judge?: Judge;
  signal?: AbortSignal;
}

export interface RankedCandidate {
  id: string;
  group: number;
  groupSize: number;
  passed: boolean | null;
  votes: number;
}

export interface SelectResult {
  winnerId: string | null;
  method: "single" | "regression" | "majority" | "judge" | "first" | "none";
  reason: string;
  pruned: string[];
  groups: string[][];
  ranking: RankedCandidate[];
  judgeTokens: number;
}

/** Added and removed lines per file, trailing spaces dropped, files sorted. */
export function normalizeDiff(diff: string): string {
  const files = new Map<string, string[]>();
  let cur = "";
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("diff --git ")) {
      cur = raw.replace(/^diff --git a\/(\S+) b\/\S+.*$/, "$1");
      continue;
    }
    if (raw.startsWith("+++ ") || raw.startsWith("--- ")) {
      if (!cur && raw.startsWith("+++ ")) cur = raw.slice(4).replace(/^b\//, "").trim();
      continue;
    }
    if ((raw.startsWith("+") || raw.startsWith("-")) && raw.trim().length > 1) {
      const list = files.get(cur) ?? [];
      list.push(`${raw[0]}${raw.slice(1).trimEnd()}`);
      files.set(cur, list);
    }
  }
  return [...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([f, ls]) => `${f}\n${ls.join("\n")}`).join("\n");
}

function fingerprint(c: Candidate): string {
  const basis = c.diff && c.diff.trim() ? `diff:${normalizeDiff(c.diff)}` : `text:${c.text.replace(/\s+/g, " ").trim().toLowerCase()}`;
  return createHash("sha256").update(basis).digest("hex");
}

export const JUDGE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["winner", "reason"],
  additionalProperties: false,
  properties: { winner: { type: "string", minLength: 1, maxLength: 80 }, reason: { type: "string", maxLength: 800 } },
};

function judgeMessages(goal: string, reps: Candidate[], sizes: Map<string, number>) {
  const blocks = reps
    .map((c) => {
      const body = c.diff?.trim() ? `Diff:\n${c.diff.slice(0, 6000)}` : `Report:\n${c.text.slice(0, 6000)}`;
      return `### Candidate ${c.id}${c.label ? ` (${c.label})` : ""}, produced by ${sizes.get(c.id) ?? 1} independent attempt(s)\n${body}`;
    })
    .join("\n\n");
  return [
    {
      role: "system" as const,
      content: [
        "You review competing solutions to the same task and pick the one most likely to be correct and complete.",
        "Prefer the solution that fully meets the goal with the smallest safe change.",
        "Do not reward length. Do not pick a solution that skips part of the goal.",
        "Agreement between independent attempts is weak evidence of correctness, not proof.",
      ].join("\n"),
    },
    { role: "user" as const, content: `Goal:\n${goal}\n\n${blocks}\n\nName the winning candidate id.` },
  ];
}

export async function selectBest(input: SelectInput): Promise<SelectResult> {
  const pool = input.candidates.filter((c) => c.ok && (c.text.trim() || c.diff?.trim())).slice(0, input.maxCandidates);
  const pruned: string[] = input.candidates.filter((c) => !pool.includes(c)).map((c) => c.id);
  if (pool.length === 0) return { winnerId: null, method: "none", reason: "no successful candidate", pruned, groups: [], ranking: [], judgeTokens: 0 };

  // 1. regression prune (keep all when none passes)
  const passed = new Map<string, boolean | null>();
  let survivors = pool;
  if (input.check) {
    for (const c of pool) {
      if (input.signal?.aborted) break;
      try {
        passed.set(c.id, (await input.check(c)).passed);
      } catch {
        passed.set(c.id, false);
      }
    }
    const ok = pool.filter((c) => passed.get(c.id) === true);
    if (ok.length > 0) {
      pruned.push(...pool.filter((c) => !ok.includes(c)).map((c) => c.id));
      survivors = ok;
    }
  }

  // 2. dedup into groups; representative = first member
  const byFp = new Map<string, Candidate[]>();
  for (const c of survivors) {
    const fp = fingerprint(c);
    byFp.set(fp, [...(byFp.get(fp) ?? []), c]);
  }
  const groups = [...byFp.values()];
  const reps = groups.map((g) => g[0] as Candidate);
  const sizes = new Map(groups.map((g) => [(g[0] as Candidate).id, g.length]));
  const ranking: RankedCandidate[] = groups.flatMap((g, gi) =>
    g.map((c) => ({ id: c.id, group: gi, groupSize: g.length, passed: passed.get(c.id) ?? null, votes: 0 })),
  );
  const groupIds = groups.map((g) => g.map((c) => c.id));
  const base = { pruned, groups: groupIds, ranking };

  if (reps.length === 1) {
    const only = reps[0] as Candidate;
    const method = input.check && survivors.length < pool.length ? "regression" : "single";
    return { ...base, winnerId: only.id, method, reason: groups[0] && groups[0].length > 1 ? `all ${groups[0].length} survivors are equivalent` : "only one distinct candidate", judgeTokens: 0 };
  }

  // 3. judge vote with early stop at a strict majority
  let judgeTokens = 0;
  if (input.judge) {
    const tally = new Map<string, number>();
    const ids = new Set(reps.map((r) => r.id));
    let lastReason = "";
    for (let v = 0; v < input.judge.votes; v++) {
      if (input.signal?.aborted) break;
      const r = await callStructured<{ winner: string; reason: string }>(input.judge.port, {
        model: input.judge.model,
        contract: "selector_judge",
        schema: JUDGE_SCHEMA,
        messages: judgeMessages(input.goal, v % 2 === 0 ? reps : [...reps].reverse(), sizes),
        repairAttempts: input.judge.repairAttempts,
        signal: input.signal,
      });
      judgeTokens += r.promptTokens + r.completionTokens;
      if (!r.ok || !ids.has(r.value.winner)) continue;
      tally.set(r.value.winner, (tally.get(r.value.winner) ?? 0) + 1);
      lastReason = r.value.reason;
      if ((tally.get(r.value.winner) ?? 0) > input.judge.votes / 2) break;
    }
    for (const rc of ranking) rc.votes = tally.get(rc.id) ?? 0;
    if (tally.size > 0) {
      const top = Math.max(...tally.values());
      const tied = reps.filter((r) => tally.get(r.id) === top);
      tied.sort((a, b) => (sizes.get(b.id) ?? 1) - (sizes.get(a.id) ?? 1));
      const w = tied[0] as Candidate;
      return { ...base, winnerId: w.id, method: "judge", reason: lastReason || `judge votes ${top}/${input.judge.votes}`, judgeTokens };
    }
  }

  // 4. fallback: largest duplicate group, then earliest candidate
  const largest = [...reps].sort((a, b) => (sizes.get(b.id) ?? 1) - (sizes.get(a.id) ?? 1))[0] as Candidate;
  const sz = sizes.get(largest.id) ?? 1;
  return {
    ...base,
    winnerId: largest.id,
    method: sz > 1 ? "majority" : "first",
    reason: sz > 1 ? `${sz} independent attempts produced this same result` : "no judge available; kept the first candidate",
    judgeTokens,
  };
}
