import type { SkillAbTask } from "./types.js";

/** Build a small default task cluster for offline / CI runs (no live model). */
export function defaultSkillAbTasks(skillId: string): SkillAbTask[] {
  return [
    { id: `${skillId}-t1`, prompt: "Summarize the README in 3 bullets.", rubric: "three bullets, faithful" },
    { id: `${skillId}-t2`, prompt: "List the public API functions.", rubric: "names match source" },
    { id: `${skillId}-t3`, prompt: "Write a minimal usage example.", rubric: "compiles conceptually" },
  ];
}
