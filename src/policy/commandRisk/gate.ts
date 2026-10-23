/**
 * Stage 2: the reflection gate.
 *
 * Adapted from jcode (MIT) ref/command-risk/src/gate.rs
 * jcode: https://github.com/1jehuang/jcode — Copyright (c) 2025 Jeremy Huang.
 *
 * Stage 1 ([`assess`]) decides *whether* a command deserves scrutiny. This
 * decides *what happens next*, and it is deliberately not another model.
 *
 * # Why not a second model
 *
 * An LLM judge is expensive, adds latency to every borderline call, and can be
 * talked around by the same reasoning that produced the command. It also creates
 * a second thing to keep aligned.
 *
 * Instead the harness refuses once and hands back a structured prompt that forces
 * the *generating* model to do the thinking it skipped. The key property is that
 * the refusal is not satisfiable by repetition: the model must supply a
 * `justification` naming what the user actually asked for. A blind retry of the
 * identical call fails again.
 *
 * This is spending test-time compute on alignment, but at the point of action
 * and with no extra model in the loop.
 */

import { explanation, type RiskAssessment } from "./lib.js";

/** Re-exported here because the refusal text is part of the gate's contract. */
export { explanation };

/** What the harness should do with a tool call. */
export type GateOutcome =
  | { kind: "Allow" }
  | { kind: "Reflect"; prompt: string }
  | { kind: "Deny"; reason: string };

/** A justification supplied by the model on a second attempt. */
export interface Justification {
  /** The model's account of which user request this serves. */
  text?: string;
}

/** Minimum characters for a justification to count as considered. */
const MIN_JUSTIFICATION_LEN = 25;

/** Reject pure affirmations, which carry no information about intent. */
const EMPTY_AFFIRMATIONS = [
  "yes",
  "ok",
  "okay",
  "sure",
  "confirmed",
  "proceed",
  "do it",
  "continue",
  "y",
  "approved",
  "go ahead",
];

export function isSubstantive(justification: Justification): boolean {
  const text = justification.text?.trim();
  if (!text || text.length < MIN_JUSTIFICATION_LEN) return false;
  const stripped = text.toLowerCase().replace(/[.!?]+$/, "").trim();
  return !EMPTY_AFFIRMATIONS.includes(stripped);
}

function reflectionPrompt(assessment: RiskAssessment): string {
  return (
    `This command was not run. It is irreversible:\n\n${explanation(assessment)}\n` +
    `Before it can proceed, stop and check it against the user's actual request:\n` +
    `- Which specific thing the user asked for requires deleting this?\n` +
    `- Did the user name this path, or did you infer it?\n` +
    `- If you inferred it, is a narrower target enough?\n` +
    `- If this is wrong, nothing here can be recovered.\n\n` +
    `If it is genuinely what the user asked for, re-issue the same call with a ` +
    "`justification` field explaining which request it serves. If you are not sure, " +
    `ask the user instead: that costs one message, and being wrong costs their data.`
  );
}

/** Decide what to do with an assessed command. */
export function gate(assessment: RiskAssessment, justification: Justification = {}): GateOutcome {
  switch (assessment.level) {
    case "Safe":
    case "Low":
      return { kind: "Allow" };
    case "Catastrophic":
      return {
        kind: "Deny",
        reason:
          `This command is blocked and cannot be confirmed.\n\n${explanation(assessment)}\n` +
          `If the user genuinely wants this, they must run it themselves outside the agent.`,
      };
    case "Confirm":
      return isSubstantive(justification)
        ? { kind: "Allow" }
        : { kind: "Reflect", prompt: reflectionPrompt(assessment) };
  }
}
