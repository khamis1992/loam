/**
 * Design-system guidance injected into agent prompts.
 *
 * The rules themselves are enforced mechanically by the static linter
 * (src/design/tokenLint.ts, exposed through the design_lint tool). This module
 * holds only the prose that tells the model WHICH rules matter and HOW to
 * respond to a report, so the prompt text can be unit-tested independently of
 * the checker and kept in sync with the category names the linter emits.
 *
 * Everything here is written for Loam's own design language; the thresholds
 * mirror the UI Kit spec rather than any third-party prompt.
 */

import { DESIGN_VIOLATION_CATEGORIES } from "../design/tokenLint.js";

/** Human names for the categories the linter reports. */
export const DESIGN_RULE_LABELS: Readonly<Record<string, string>> = {
  "raw-colour": "a literal colour instead of a semantic token",
  "too-many-colours": "more than five distinct colours",
  "too-many-fonts": "more than two font families",
  "arbitrary-px": "an arbitrary pixel value off the spacing scale",
  "emoji-icon": "an emoji used where a real icon belongs",
  "missing-alt": "an image without alt text",
  "gradient": "a decorative gradient",
  "rtl-logical-properties": "a physical directional property under an RTL layout",
  "rtl-direction": "Arabic content without a declared right-to-left direction",
};

/** The category list the linter can emit (kept in sync with the checker). */
export const DESIGN_LINT_CATEGORIES: readonly string[] = DESIGN_VIOLATION_CATEGORIES;

/**
 * Prompt directive shown to any run that can call design_lint. It is
 * deliberately prescriptive: the model must lint before presenting a UI and
 * must fix what the report flags rather than merely describing it.
 */
export const DESIGN_LINT_PROMPT: string = [
  "Design system: generated UI must follow the Loam UI Kit. Use semantic colour tokens (bg-background, text-foreground, bg-primary, border-border and friends), at most five distinct colours, at most two font families, the Tailwind spacing scale instead of arbitrary pixel values, real icons from one icon set (16, 20 or 24 px) instead of emoji, alt text on every image, and no decorative gradients.",
  "Before presenting or finishing a generated UI, run design_lint on the source (or on the task paths) and fix every reported violation in place. Report only what the tool returned; do not claim a clean pass without running it. If a rule genuinely does not apply, pass the category through the tool's `disabled` option and say why.",
  "Right-to-left layouts (Arabic and other RTL scripts) must use logical properties: ms/me for margin, ps/pe for padding, start/end for positioning and borders, text-start/text-end for alignment, and border-inline-*/padding-inline-*. Never use ml/mr, pl/pr, left/right or text-left/text-right when the layout is RTL. Declare dir=\"rtl\" and lang=\"ar\" on the root whenever the content is Arabic.",
].join("\n");
