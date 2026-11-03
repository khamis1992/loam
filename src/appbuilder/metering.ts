// src/appbuilder/metering.ts — Cap G §4.14: per-run, per-role usage rows in
// app_usage on top of Loam's single-source-of-truth credit ledger. The run total
// still goes through recordTaskUsage(runId, usage) once; this table is the
// breakdown that version cards and the Usage panel read. The ledger itself never
// discounts cached tokens (OD-4) — only the version-card display does (0.1).
import { randomUUID } from "node:crypto";
import { database } from "../server/sqliteStore.js";
import { TOKENS_PER_CREDIT } from "../server/credits.js";
import type { VersionUsage } from "./types.js";

export type AppUsageKind = "build" | "race" | "title" | "visual";

export interface AppUsageRow {
  projectId: string;
  runId: string | null;
  role: string;
  step: string;
  kind: AppUsageKind;
  tier: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  toolCalls: number;
  durationMs: number;
}

export function recordAppUsage(row: AppUsageRow): void {
  database().prepare(
    `INSERT INTO app_usage (project_id, run_id, role, step, kind, tier, prompt_tokens, completion_tokens, cached_tokens, tool_calls, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.projectId, row.runId, row.role.slice(0, 40), row.step.slice(0, 60), row.kind, row.tier.slice(0, 20),
    Math.max(0, Math.floor(row.promptTokens)), Math.max(0, Math.floor(row.completionTokens)),
    Math.max(0, Math.floor(row.cachedTokens)), Math.max(0, Math.floor(row.toolCalls)),
    Math.max(0, Math.floor(row.durationMs)), new Date().toISOString(),
  );
}

export interface UsageRollupRow {
  runId: string | null;
  role: string;
  kind: AppUsageKind;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  toolCalls: number;
  durationMs: number;
}

export interface UsageTotals {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  toolCalls: number;
  durationMs: number;
}

interface RawRow {
  run_id: string | null; role: string; kind: string; calls: number;
  prompt_tokens: number; completion_tokens: number; cached_tokens: number;
  tool_calls: number; duration_ms: number;
}

/** Per run × role × kind roll-up, newest run first. `runId` narrows to one run. */
export function appUsage(projectId: string, runId?: string): { rows: UsageRollupRow[]; totals: UsageTotals } {
  const rows = (database().prepare(
    `SELECT run_id, role, kind, COUNT(*) AS calls, SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens,
            SUM(cached_tokens) AS cached_tokens, SUM(tool_calls) AS tool_calls, SUM(duration_ms) AS duration_ms
     FROM app_usage WHERE project_id = ? ${runId ? "AND run_id = ?" : ""}
     GROUP BY run_id, role, kind ORDER BY MIN(created_at) DESC LIMIT 500`,
  ).all(...(runId ? [projectId, runId] : [projectId])) as unknown as RawRow[]).map((r) => ({
    runId: r.run_id, role: r.role, kind: r.kind as AppUsageKind, calls: r.calls,
    promptTokens: r.prompt_tokens, completionTokens: r.completion_tokens, cachedTokens: r.cached_tokens,
    toolCalls: r.tool_calls, durationMs: r.duration_ms,
  }));
  const totals = rows.reduce<UsageTotals>(
    (acc, r) => ({
      calls: acc.calls + r.calls, promptTokens: acc.promptTokens + r.promptTokens,
      completionTokens: acc.completionTokens + r.completionTokens, cachedTokens: acc.cachedTokens + r.cachedTokens,
      toolCalls: acc.toolCalls + r.toolCalls, durationMs: acc.durationMs + r.durationMs,
    }),
    { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, toolCalls: 0, durationMs: 0 },
  );
  return { rows, totals };
}

/** Version-card display rule (OD-4): cached prompt tokens count at 0.1; the ledger does not. */
export function displayCredits(promptTokens: number, completionTokens: number, cachedTokens: number): number {
  const effective = Math.max(0, promptTokens - cachedTokens) + cachedTokens * 0.1 + completionTokens;
  return Math.max(1, Math.ceil(effective / TOKENS_PER_CREDIT));
}

/** The shape a version card / race branch shows ("Cost: N credits · M tool calls · T s"). */
export function versionUsageSummary(rows: UsageRollupRow[]): VersionUsage {
  const total = rows.reduce<UsageTotals>(
    (acc, r) => ({
      calls: acc.calls + r.calls, promptTokens: acc.promptTokens + r.promptTokens,
      completionTokens: acc.completionTokens + r.completionTokens, cachedTokens: acc.cachedTokens + r.cachedTokens,
      toolCalls: acc.toolCalls + r.toolCalls, durationMs: acc.durationMs + r.durationMs,
    }),
    { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, toolCalls: 0, durationMs: 0 },
  );
  return {
    promptTokens: total.promptTokens,
    completionTokens: total.completionTokens,
    cachedTokens: total.cachedTokens,
    credits: displayCredits(total.promptTokens, total.completionTokens, total.cachedTokens),
    wallMs: total.durationMs,
    toolCalls: total.toolCalls,
  };
}

/** Stable usage id for race branches (kept JSON in app_race_branches.usage). */
export const usageKey = (): string => `usage_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
