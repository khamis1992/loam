/**
 * H10 — eval-only probe (BUILD_SPEC section 9 D).
 *
 * For one failed eval case: generate 2 candidate lesson blocks (INV = generic,
 * DOM = domain), run the case with each through the existing eval runner, and
 * keep the block whose verifier score is higher. Ties keep the base. Budget:
 * at most 2 extra rollouts per case. Never used in live tasks.
 *
 * Reference: .h2-ref/BUILD_SPEC.md section 9 D. No upstream code is copied;
 * the idea is re-implemented independently.
 */

import type { Lesson } from "./types.js";

/** Maximum extra rollouts beyond the base per case (BUILD_SPEC §9 D budget). */
export const MAX_EXTRA_ROLLOUTS = 2;

/** Maximum characters in a lesson block (BUILD_SPEC §6.5). */
export const LESSON_BLOCK_MAX_CHARS = 1200;

/** A runner scores a prompt (with a lesson block) — 0..1, injected for tests. */
export type EvalRunner = (prompt: string) => Promise<number>;

export interface ProbeOptions {
  lessons: Lesson[];
  domain: string;
  runner: EvalRunner;
  /** Override the default budget (default MAX_EXTRA_ROLLOUTS). */
  maxExtraRollouts?: number;
}

export interface ProbeResult {
  inv: string;        // generic (INV) candidate block
  dom: string;        // domain-specific (DOM) candidate block
  chosen: string;     // block kept (empty = base on tie)
  invScore: number;   // verifier score for INV
  domScore: number;   // verifier score for DOM
  extraRollouts: number; // extra rollouts performed (≤ MAX_EXTRA_ROLLOUTS)
}

/**
 * Build a lesson block from a list of lessons, capped at LESSON_BLOCK_MAX_CHARS.
 * Same wording as BUILD_SPEC §6.5 buildLessonBlock.
 */
export function buildLessonBlock(lessons: Lesson[]): string {
  if (!lessons.length) return "";
  const lines = ["## Learned from earlier corrections (apply when the cue matches)"];
  for (const l of lessons) {
    const line = `- When ${l.cue.replace(/\.$/, "")}: ${l.lesson}`;
    if (lines.join("\n").length + line.length > LESSON_BLOCK_MAX_CHARS) break;
    lines.push(line);
  }
  return lines.join("\n");
}

/** Generate the two candidate blocks: INV (all lessons) and DOM (domain only). */
export function buildCandidates(lessons: Lesson[], domain: string): { inv: string; dom: string } {
  const inv = buildLessonBlock(lessons);
  const dom = buildLessonBlock(lessons.filter((l) => l.domain === domain));
  return { inv, dom };
}

/**
 * Run the probe: score INV and DOM (at most 2 extra rollouts), keep the
 * higher-scoring block; ties keep the base (empty block).
 */
export async function probe(opts: ProbeOptions): Promise<ProbeResult> {
  const { inv, dom } = buildCandidates(opts.lessons, opts.domain);
  const maxExtra = opts.maxExtraRollouts ?? MAX_EXTRA_ROLLOUTS;

  let invScore = 0;
  let domScore = 0;
  let extraRollouts = 0;

  // Rollout 1: INV (generic)
  if (extraRollouts < maxExtra) {
    invScore = await opts.runner(inv);
    extraRollouts++;
  }

  // Rollout 2: DOM (domain-specific)
  if (extraRollouts < maxExtra) {
    domScore = await opts.runner(dom);
    extraRollouts++;
  }

  // Keep the better-scoring block; ties keep the base (empty block).
  let chosen = "";
  if (invScore > domScore) {
    chosen = inv;
  } else if (domScore > invScore) {
    chosen = dom;
  }

  return { inv, dom, chosen, invScore, domScore, extraRollouts };
}