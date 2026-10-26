export interface SkillAbTask {
  id: string;
  prompt: string;
  /** Expected graded score in [0,1] when the skill helps. */
  rubric: string;
}

export interface SkillAbTrialResult {
  taskId: string;
  trial: number;
  arm: "baseline" | "withSkill" | "discoverable";
  score: number;
  tokens: number;
}

export interface SkillAbRunConfig {
  skillId: string;
  tasks: SkillAbTask[];
  trialsPerTask: number;
  includeDiscoverable?: boolean;
  seed?: number;
  bootstrapIterations?: number;
}
