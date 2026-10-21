/**
 * Build mode sub-phases.
 *
 * The build run now starts with a passive design-exploration phase: before
 * writing any code the model must surface 2-3 concrete design directions
 * (palette, layout and hero concept), then implement the chosen direction.
 * The phase is config-only here — the actual direction generation lives in
 * the loam_design tool (src/tools/designExplore.ts), which the agent mode
 * gate exposes.
 */

export interface BuildPhase {
  id: string;
  order: number;
  title: string;
  titleAr: string;
  /** One-line instruction injected into the system prompt while this phase is active. */
  instruction: string;
  /** Tool gate: tools that MUST be reachable for the phase to be meaningful. */
  tools: readonly string[];
}

export interface BuildSubPhaseConfig {
  mode: "build";
  phases: BuildPhase[];
  /** Phase active at run start. */
  entryPhaseId: string;
}

const PHASES: BuildPhase[] = [
  {
    id: "design-explore",
    order: 0,
    title: "Design exploration",
    titleAr: "استكشاف التصميم",
    instruction:
      "Design phase: before writing any code, produce 2-3 design directions with loam_design (explore): each direction must state a palette, a layout and a hero concept. Pick a direction with the user or proceed with the strongest one, optionally generate the hero image (loam_design generate_hero), then implement it faithfully.",
    tools: ["loam_design"],
  },
  {
    id: "implement",
    order: 1,
    title: "Implement",
    titleAr: "تنفيذ",
    instruction: "Implement the chosen design directly in the task workspace without renegotiating the visual concept mid-run.",
    tools: [],
  },
];

export const BUILD_SUBPHASES: BuildSubPhaseConfig = {
  mode: "build",
  phases: PHASES,
  entryPhaseId: "design-explore",
};

export function getBuildPhase(phaseId: string): BuildPhase {
  const phase = PHASES.find((p) => p.id === phaseId);
  if (!phase) throw new Error(`Unknown build phase: ${phaseId}`);
  return phase;
}

/** Prompt directive injected when the design-exploration phase can run. */
export const BUILD_PHASE_PROMPT: string = getBuildPhase(BUILD_SUBPHASES.entryPhaseId).instruction;
