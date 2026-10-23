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
      "Design phase: before writing any code, call design_brief to produce one validated visual system — a 3-5 colour semantic palette, at most two typefaces, a mobile-first layout plan, the imagery the page needs and the accessibility rules — and keep it consistent throughout the build. Use loam_design (explore) for 2-3 deterministic hero directions and generate_hero for the hero image, then implement the chosen design faithfully. Reference the returned semantic tokens, never raw colours, and make sure the finished UI passes design_lint with no violations.",
    tools: ["design_brief", "loam_design", "design_lint"],
  },
  {
    id: "implement",
    order: 1,
    title: "Implement",
    titleAr: "تنفيذ",
    instruction: "Implement the chosen design directly in the task workspace without renegotiating the visual concept mid-run. Lint the UI with design_lint before finishing and fix every reported violation.",
    tools: ["design_lint"],
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
