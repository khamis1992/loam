/**
 * Blast-radius shell command risk classifier.
 *
 * Public surface of the port of jcode's `command-risk` crate.
 *
 * Adapted from jcode (MIT) ref/command-risk/src/{lib,paths,tokenize,gate}.rs
 * jcode: https://github.com/1jehuang/jcode — Copyright (c) 2025 Jeremy Huang.
 *
 * Two stages, deliberately:
 *
 * 1. `assess()` is a cheap, deterministic, high-recall filter. It classifies a
 *    command by what it would destroy and whether that is reversible.
 * 2. `gate()` turns a non-safe assessment into a reflection prompt that the
 *    *generating* model must answer. It is not a second model.
 *
 * The usual entry point for Loam's approval gate is `assessCommand()`, which
 * builds a `RiskContext` from the current environment and returns the verdict.
 */

export {
  assess,
  maxLevel,
  runsImmediately,
  isAbsoluteDeny,
  severity,
  type RiskAssessment,
  type RiskContext,
  type RiskFinding,
  type RiskLevel,
} from "./lib.js";
export { gate, isSubstantive, explanation, type GateOutcome, type Justification } from "./gate.js";
export { splitSegments, tokenize, embeddedSubstitutions, type Token } from "./tokenize.js";
export {
  classifyTarget,
  expand,
  expandKnownPrefix,
  isCatastrophicTarget,
  isSafeRedirectSink,
  isTempPath,
  normalize,
  pathJoin,
  pathParent,
  pathStartsWith,
} from "./paths.js";

import { assess, type RiskContext, type RiskLevel } from "./lib.js";
import { gate } from "./gate.js";

/** Build the risk context for a shell call from the Loam environment.
 *
 *  The caller supplies the working directory it is about to use, so the
 *  classifier never has to guess where a relative target lands. */
export function riskContextFromEnvironment(
  workingDir?: string,
  scratchDir?: string,
): RiskContext {
  return {
    workingDir,
    homeDir: process.env.HOME || process.env.USERPROFILE || undefined,
    scratchDir: scratchDir || process.env.JCODE_SCRATCH_DIR || undefined,
  };
}

/** Convenience entry point: assess a command against an environment context. */
export function assessCommand(
  command: string,
  context: RiskContext = riskContextFromEnvironment(),
): import("./lib.js").RiskAssessment {
  return assess(command, context);
}

/** The outcome of running both cascade stages for one shell command. */
export interface CommandRiskDecision {
  /** Whether the command may run exactly as issued. */
  ok: boolean;
  /** Stage-1 blast-radius verdict, kept for logging and tier mapping. */
  level: RiskLevel;
  /** Refusal text to hand back to the model when `ok` is false. */
  reason?: string;
  /** True when re-issuing the same call with a substantive `justification`
   *  unlocks it; false for the absolute (catastrophic) deny. */
  retryable: boolean;
}

/**
 * Stage 1 + stage 2 in one call: assess a command, then decide what the harness
 * should do with it.
 *
 * This is the seam the approval gate calls. `ok === false` means the command
 * must not run as issued, and `retryable` distinguishes the two refusal kinds:
 * a `Confirm` verdict can be unlocked by re-issuing the same call with a
 * justification naming the user request it serves, while a `Catastrophic` one is
 * an absolute deny that no justification unlocks.
 */
export function checkCommandRisk(
  command: string,
  options: { workingDir?: string; scratchDir?: string; justification?: string } = {},
): CommandRiskDecision {
  const assessment = assess(command, riskContextFromEnvironment(options.workingDir, options.scratchDir));
  const outcome = gate(assessment, { text: options.justification });
  switch (outcome.kind) {
    case "Allow":
      return { ok: true, level: assessment.level, retryable: false };
    case "Deny":
      return { ok: false, level: assessment.level, reason: outcome.reason, retryable: false };
    case "Reflect":
      return { ok: false, level: assessment.level, reason: outcome.prompt, retryable: true };
  }
}
