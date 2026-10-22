/**
 * Pluggable design critique (V1 seed, extended by V11).
 *
 * The critique is a separate, injectable step so the eval harness can run with
 * a deterministic mock (tests, self-check, offline CI) or a real vision model
 * (V11 wires `visualReview`). The score is a 0-100 rubric over the dimensions
 * the Loam UI Kit cares about: hierarchy, spacing, contrast, alignment, colour
 * count, overflow, and RTL correctness for Arabic locales.
 */

import type { LintResult } from "./tokenLint.js";

export interface CritiqueDimension {
  id: string;
  label: string;
  /** 0-100. */
  score: number;
  note: string;
}

export interface CritiqueExpectations {
  /** Copy/landmark strings that must appear in the built site. */
  must?: string[];
  /** Copy that must not appear (e.g. lorem ipsum). */
  mustNot?: string[];
  /** Coverage of `must` entries found in the built output, 0-1. */
  coverage?: number;
}

export interface CritiqueInput {
  siteDir: string;
  fixtureId: string;
  prompt: string;
  locale: string;
  direction: "ltr" | "rtl";
  lint: LintResult;
  expectations?: CritiqueExpectations;
}

export interface CritiqueResult {
  /** 0-100 mean of the dimension scores. */
  score: number;
  dimensions: CritiqueDimension[];
  notes: string[];
}

export interface DesignCritique {
  critique(input: CritiqueInput): Promise<CritiqueResult>;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Deterministic mock critique. It never calls a model and never touches the
 * network, which makes the eval harness safe to run in unit tests and offline.
 * It derives a plausible rubric from the lint result and expectation coverage so
 * regressions in the linter surface as lower critique scores.
 */
export function mockDesignCritique(): DesignCritique {
  return {
    async critique(input: CritiqueInput): Promise<CritiqueResult> {
      const lint = input.lint.score;
      const coverage = input.expectations?.coverage ?? 1;
      const rtl = input.direction === "rtl";
      const rtlReady = input.lint.metrics.rtlReady;
      const dimensionScore = (base: number): number => clamp(base + lint * 0.3 + coverage * 8);

      const dimensions: CritiqueDimension[] = [
        { id: "hierarchy", label: "Visual hierarchy", score: dimensionScore(55), note: "headline scale, weight and section order" },
        { id: "spacing", label: "Spacing rhythm", score: dimensionScore(55), note: "consistent gaps and section padding" },
        { id: "contrast", label: "Text contrast", score: dimensionScore(60), note: "AA contrast for body and muted text" },
        { id: "alignment", label: "Alignment", score: dimensionScore(60), note: "edge alignment and optical centering" },
        { id: "color-count", label: "Colour discipline", score: dimensionScore(50), note: "few colours, tokens only, no gradients" },
        { id: "overflow", label: "Overflow control", score: dimensionScore(65), note: "no horizontal scroll at mobile widths" },
        {
          id: "rtl",
          label: "RTL correctness",
          score: rtl ? (rtlReady ? 95 : 55) : 90,
          note: rtl ? "dir=rtl, logical properties, Arabic-capable type" : "not applicable for this locale",
        },
      ];

      const score = clamp(dimensions.reduce((sum, d) => sum + d.score, 0) / dimensions.length);

      const notes: string[] = [];
      if (rtl && !rtlReady) notes.push("site is not RTL-ready for an Arabic locale");
      if (lint < 80) notes.push(`lint score ${lint} is below the 80 bar`);
      if (coverage < 1) notes.push(`expectation coverage is ${(coverage * 100).toFixed(0)}%`);
      if (notes.length === 0) notes.push("no blocking issues found by the mock rubric");

      return { score, dimensions, notes };
    },
  };
}
