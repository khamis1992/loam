// src/appbuilder/race.ts — Cap G §4.13: Race estimate + branch scoring. Several
// teams run the same prompt in scratch trees; the verify loop scores each branch
// and the USER still chooses (OD-8). A branch that fails to build can score at
// most 30, so it never outranks one that builds.
import { database } from "../server/sqliteStore.js";
import { FLAT_USAGE_CREDITS, TOKENS_PER_CREDIT } from "../server/credits.js";
import type { RaceEstimate, RaceScore, VerifyReport } from "./types.js";

export const DEFAULT_RUN_CREDITS = FLAT_USAGE_CREDITS; // 10 at 5227rf43-era credits.ts
export const BUDGET_FACTOR = 1.5;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function raceEstimate(projectId: string, branches: 2 | 3 | 4): RaceEstimate {
  const rows = database().prepare(
    `SELECT r.id, SUM(u.prompt_tokens + u.completion_tokens) AS tokens
     FROM app_runs r JOIN app_usage u ON u.run_id = r.id
     WHERE r.project_id = ? AND r.flavor = 'quick' AND r.status = 'done' AND r.race_id IS NULL
     GROUP BY r.id ORDER BY r.started_at DESC LIMIT 5`,
  ).all(projectId) as Array<{ id: string; tokens: number }>;
  const credits = rows.map((r) => Math.max(1, Math.ceil(r.tokens / TOKENS_PER_CREDIT)));
  const perRunCredits = credits.length ? median(credits) : DEFAULT_RUN_CREDITS;
  return {
    branches,
    perRunCredits,
    extraCredits: Math.ceil((branches - 1) * perRunCredits + branches),
    maxTotalCredits: Math.ceil(branches * BUDGET_FACTOR * perRunCredits),
    basis: credits.length ? "history" : "default",
    sampleRuns: credits.length,
  };
}

export const RACE_WEIGHTS = { build: 40, check: 15, lint: 10, visualPass: 20, visualUnavailable: 10, consoleClean: 5, requirementCoverage: 10 } as const;

export function scoreBranch(r: VerifyReport, requirementCoverage: number): RaceScore {
  const ok = (id: string) => r.steps.some((s) => s.id === id && s.ok);
  const build = ok("build") ? RACE_WEIGHTS.build : 0;
  const check = ok("check") ? RACE_WEIGHTS.check : 0;
  const lint = ok("lint") ? RACE_WEIGHTS.lint : 0;
  const visual = r.visualVerdict === "pass" ? RACE_WEIGHTS.visualPass : r.visualVerdict === "unavailable" ? RACE_WEIGHTS.visualUnavailable : 0;
  const consoleClean = build && r.consoleErrors === 0 ? RACE_WEIGHTS.consoleClean : 0;
  const coverage = Math.max(0, Math.min(RACE_WEIGHTS.requirementCoverage, Math.round(requirementCoverage)));
  // §4.13.2: a branch whose build failed scores AT MOST 30 (check, lint, coverage),
  // so a broken branch never outranks one that builds. The prose is the contract;
  // the raw sum alone would not enforce it.
  const raw = build + check + lint + visual + consoleClean + coverage;
  return { total: build ? raw : Math.min(raw, 30), build, check, lint, visual, consoleClean, requirementCoverage: coverage };
}
