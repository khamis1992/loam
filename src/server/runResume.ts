import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { ExecutionCheckpoint } from "../agent/checkpoint.js";
import { after } from "../protocol/eventLog.js";
import { getCheckpointRef } from "../orchestration/durable/checkpoints.js";
import type { ResumeFromInterrupt } from "./routes/interrupts.js";
import type { StartForkedRun } from "./routes/checkpoints.js";
import type { RunTaskOptions } from "./http.js";
import { createTask, getSavedRun, getTask, saveRun } from "./db.js";
import { ensureTaskWorkspace } from "./taskWorkspace.js";

interface RunResumeDeps {
  cfg: Config;
  runTask(opts: RunTaskOptions): Promise<{ taskId: string; text: string }>;
}

export function createRunResume(deps: RunResumeDeps): {
  startForkedRun: StartForkedRun;
  resumeFromInterrupt: ResumeFromInterrupt;
} {
  const startForkedRun: StartForkedRun = async (forkTaskId, sourceTaskId, checkpoint) => {
    const saved = getSavedRun(sourceTaskId);
    if (!saved) throw new Error("source execution is unavailable");
    const source = getTask(sourceTaskId);
    createTask(saved.prompt, `Fork: ${source?.title ?? sourceTaskId}`, saved.projectId, saved.agentId, forkTaskId);
    const workspace = ensureTaskWorkspace(forkTaskId, deps.cfg.workspace);
    if (fs.existsSync(saved.workspace)) fs.cpSync(saved.workspace, workspace, { recursive: true, filter: (file) => {
      const relative = path.relative(saved.workspace, file);
      const top = relative.split(path.sep)[0] ?? "";
      return relative === "" || ![".git", ".loam", "node_modules"].includes(top);
    } });
    saveRun(forkTaskId, {
      ...saved,
      started: true,
      checkpoint,
      workspace,
    });
    await deps.runTask({ taskId: forkTaskId, prompt: saved.prompt, resume: true, retryInterruptedStep: true, emit: () => {} });
  };

  const resumeFromInterrupt: ResumeFromInterrupt = async (record) => {
    const saved = getSavedRun(record.taskId);
    if (!saved) return false;
    if (record.checkpointId) {
      const ref = getCheckpointRef(record.checkpointId);
      if (!ref || ref.taskId !== record.taskId) throw new Error("interrupt checkpoint is unavailable");
      const event = after(ref.sessionId, Math.max(0, ref.logSeq - 1), 1)[0];
      if (!event) throw new Error("interrupt checkpoint body is unavailable");
      saved.checkpoint = structuredClone(event.payload) as ExecutionCheckpoint;
    }
    saveRun(record.taskId, saved);
    await deps.runTask({ taskId: record.taskId, prompt: saved.prompt, resume: true, retryInterruptedStep: true, emit: () => {} });
    return true;
  };

  return { startForkedRun, resumeFromInterrupt };
}
