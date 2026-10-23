// H3 correction detector: "did the user just correct the agent?"
// Reference design: BUILD_SPEC .h2-ref/BUILD_SPEC.md section 6.3. No code is copied
// from the upstream Harness2 project; the idea is re-implemented independently.
//
// This detector is the FIRST stage of the correction-learning flow (flow A in BUILD_SPEC
// section 9). It is deliberately deterministic: no model call, no network, no state.
// It runs inline on the chat path, so it must be cheap and must never throw.
//
// Scope notes (what it is NOT):
//   - It does not store anything. Storing is H2 `experienceStore.recordCorrection`.
//   - It does not decide what to learn. Distillation is H4 `distill`.
//   - A positive result is only a *candidate*. H8 decides whether to distil it.

/** English correction / negation cues. Word boundaries keep "another" and "donor" out. */
const EN_PATTERNS: RegExp[] = [
  /\b(no|nope|wrong|incorrect|that'?s not|not what i (asked|meant|wanted)|i said|i told you|don'?t|stop|instead|should (be|have)|again,? )\b/i,
];

/**
 * Arabic cues: Modern Standard Arabic plus Gulf colloquial. Kept as unicode literals.
 * Per the task rules these are written with the file-edit tool only, never through a
 * shell (the Windows shell corrupts non-ASCII into mojibake).
 * Note the first alternative: "لا" followed by a comma, another Arabic comma, or
 * whitespace, so the standalone word "لا" does not need a trailing space in the regex.
 */
const AR_PATTERNS: RegExp[] = [
  /(لا[،,\s]|غلط|خطأ|مو كذا|مب كذا|مو هذا|قلت لك|قلتلك|لا ت|ليش سويت|المفروض|بدال|بدل ما|مرة ثانية|ترا |ترى )/u,
];

/** A correction is usually short: this is a soft prior, not a hard rule. */
const SHORT_CORRECTION_MAX_CHARS = 400;

/** Base score for a matched cue. */
const SCORE_MATCH = 0.6;
/** Bonus for a short message (corrections are usually terse). */
const SCORE_SHORT = 0.1;
/** Bonus when the message opens with a negation. */
const SCORE_OPENS_NEGATION = 0.2;
/** Anything at or above this is reported as a correction. */
export const CORRECTION_THRESHOLD = 0.6;

export interface DetectInput {
  /** Last assistant text before the user's message; null/empty when there is no prior turn. */
  priorAssistant: string | null;
  /** The user's message. */
  userText: string;
}

export interface DetectResult {
  isCorrection: boolean;
  /** Confidence in [0, 1]; a plain score, not a calibrated probability. */
  score: number;
  /** The exact cue substrings that matched, in pattern order (may contain duplicates). */
  matched: string[];
}

/**
 * Decide whether `userText` is a correction of `priorAssistant`.
 *
 * Returns `isCorrection: false` with score 0 when there is no prior assistant turn
 * (a correction must correct something) or when the message is blank. The score is
 * capped at 1 so callers can treat it as a bounded signal.
 */
export function detectCorrection(i: DetectInput): DetectResult {
  const user = i.userText ?? "";
  const prior = i.priorAssistant ?? "";
  if (!prior.trim() || !user.trim()) return { isCorrection: false, score: 0, matched: [] };

  const t = user.trim();
  const matched = [...EN_PATTERNS, ...AR_PATTERNS].flatMap((p) => {
    const m = t.match(p);
    return m ? [m[0].trim()] : [];
  });

  let score = matched.length ? SCORE_MATCH : 0;
  if (t.length < SHORT_CORRECTION_MAX_CHARS) score += SCORE_SHORT;
  if (/^(لا|no)\b/iu.test(t)) score += SCORE_OPENS_NEGATION;
  score = Math.min(score, 1);

  return { isCorrection: score >= CORRECTION_THRESHOLD, score, matched };
}
