import { analyseAb, type TrialPair } from "./stats.js";
import { defaultSkillAbTasks } from "./generate.js";
import { saveAbRun, type StoredAbRun } from "./store.js";
import type { SkillAbRunConfig } from "./types.js";

export interface GradeFns {
  /** Grade a completion; returns score in [0,1]. */
  grade: (args: { taskId: string; arm: string; text: string }) => Promise<number>;
  /** Produce a completion for an arm. */
  complete: (args: { taskId: string; prompt: string; arm: "baseline" | "withSkill" | "discoverable"; skillId: string }) => Promise<{ text: string; tokens: number }>;
}

/**
 * Run controlled A/B. For CI without a model, inject complete/grade fakes.
 * Cluster-bootstraps via analyseAb (task-level).
 */
export async function runSkillAb(cfg: SkillAbRunConfig, grade: GradeFns, outDir?: string): Promise<StoredAbRun> {
  const tasks = cfg.tasks.length ? cfg.tasks : defaultSkillAbTasks(cfg.skillId);
  const pairs: TrialPair[] = [];
  for (const task of tasks) {
    for (let trial = 1; trial <= cfg.trialsPerTask; trial++) {
      const base = await grade.complete({ taskId: task.id, prompt: task.prompt, arm: "baseline", skillId: cfg.skillId });
      const withS = await grade.complete({ taskId: task.id, prompt: task.prompt, arm: "withSkill", skillId: cfg.skillId });
      const bScore = await grade.grade({ taskId: task.id, arm: "baseline", text: base.text });
      const wScore = await grade.grade({ taskId: task.id, arm: "withSkill", text: withS.text });
      pairs.push({
        taskId: task.id, trial,
        baseline: clamp01(bScore), withSkill: clamp01(wScore),
        baselineTokens: base.tokens, withSkillTokens: withS.tokens,
      });
      if (cfg.includeDiscoverable) {
        // Optional B′ arm recorded in properties only in v1 store via perTask notes — skipped in pairs schema.
        await grade.complete({ taskId: task.id, prompt: task.prompt, arm: "discoverable", skillId: cfg.skillId });
      }
    }
  }
  const result = analyseAb(pairs, { iterations: cfg.bootstrapIterations ?? 2000, seed: cfg.seed ?? 1337 });
  const run: StoredAbRun = {
    v: 1,
    runId: `ab_${cfg.skillId}_${Date.now()}`,
    createdAt: new Date().toISOString(),
    config: {
      skillId: cfg.skillId,
      trialsPerTask: cfg.trialsPerTask,
      includeDiscoverable: cfg.includeDiscoverable,
      seed: cfg.seed,
      bootstrapIterations: cfg.bootstrapIterations,
      taskIds: tasks.map((t) => t.id),
    },
    result,
  };
  if (outDir) saveAbRun(outDir, run);
  return run;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
