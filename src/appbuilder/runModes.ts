// src/appbuilder/runModes.ts
import type { AppRoleId, AppRunFlavor } from "./types.js";

export type AppPhaseId =
  | "scaffold"
  | "design-doc"
  | "clarify"
  | "plan"
  | "approve"
  | "context"
  | "assign"
  | "implement"
  | "verify"
  | "finish"
  | "version";

export interface AppRunModeConfig {
  flavor: AppRunFlavor;
  label: string;
  labelAr: string;
  hint: string;
  hintAr: string;
  entryRole: AppRoleId;
  phases: AppPhaseId[];
  /** Maximum agent steps for the whole run (all roles). */
  maxSteps: number;
  /** Maximum tool calls by the implementing role before a forced verify. */
  maxImplementToolCalls: number;
}

export const APP_RUN_MODES: Record<AppRunFlavor, AppRunModeConfig> = {
  quick: {
    flavor: "quick",
    label: "Build",
    labelAr: "ابنِ",
    hint: "One engineer builds it directly.",
    hintAr: "مهندس واحد يبنيه مباشرة.",
    entryRole: "engineer",
    phases: ["scaffold", "design-doc", "implement", "verify", "version"],
    maxSteps: 40,
    maxImplementToolCalls: 28,
  },
  goal: {
    flavor: "goal",
    label: "Goal",
    labelAr: "هدف",
    hint: "The lead asks, plans, waits for your approval, then assigns the build.",
    hintAr: "القائد يسأل ويخطط وينتظر موافقتك ثم يوزّع البناء.",
    entryRole: "lead",
    phases: ["scaffold", "clarify", "plan", "approve", "context", "assign", "design-doc", "implement", "verify", "finish", "version"],
    maxSteps: 90,
    maxImplementToolCalls: 48,
  },
};

export function runModeFor(flavor: AppRunFlavor): AppRunModeConfig {
  return APP_RUN_MODES[flavor];
}

/** Phases skipped when their precondition is already satisfied. */
export function shouldSkipPhase(
  phase: AppPhaseId,
  state: { appDirEmpty: boolean; designDocExists: boolean; questionsSkipped: boolean },
): boolean {
  if (phase === "scaffold") return !state.appDirEmpty;
  if (phase === "design-doc") return state.designDocExists;
  if (phase === "clarify") return state.questionsSkipped;
  return false;
}
