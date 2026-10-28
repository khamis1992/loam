import type { Task } from "../../server/db.js";
import type { SavedRun } from "../../server/recovery.js";
import { legalProtection } from "./protection.js";
import { isSealedLegalPayload, type SealedLegalPayload } from "./transcriptSeal.js";

export function protectTask(task: Task): Task {
  if (task.mode !== "legal") return task;
  const protection = legalProtection();
  const out = structuredClone(task) as Task & { sealedPrompt?: SealedLegalPayload; sealedTitle?: SealedLegalPayload };
  if (out.prompt) {
    out.sealedPrompt = protection.seal(out.prompt, `task|${out.id}|prompt`);
    out.prompt = "";
  }
  if (out.title && out.title !== "Legal matter") {
    out.sealedTitle = protection.seal(out.title, `task|${out.id}|title`);
    out.title = "Legal matter";
  }
  out.messages = out.messages.map((message, index) => {
    if (!message.content) return message;
    return { ...message, content: "", sealedContent: protection.seal(message.content, `task|${out.id}|message|${index}`) };
  });
  out.steps = out.steps.map((step, index) => ({
    ...step,
    data: step.data === undefined ? undefined : protection.seal(step.data, `step|${out.id}|${index}`),
  }));
  return out;
}

export function openTask(task: Task): Task {
  if (task.mode !== "legal") return task;
  const protection = legalProtection();
  const out = structuredClone(task) as Task & { sealedPrompt?: SealedLegalPayload; sealedTitle?: SealedLegalPayload };
  if (out.sealedPrompt) {
    out.prompt = protection.open<string>(out.sealedPrompt);
    delete out.sealedPrompt;
  }
  if (out.sealedTitle) {
    out.title = protection.open<string>(out.sealedTitle);
    delete out.sealedTitle;
  }
  out.messages = out.messages.map((message) => {
    if (!message.sealedContent) return message;
    const opened = { ...message, content: protection.open<string>(message.sealedContent) };
    delete opened.sealedContent;
    return opened;
  });
  out.steps = out.steps.map((step) => ({
    ...step,
    data: isSealedLegalPayload(step.data) ? protection.open(step.data) : step.data,
  }));
  return out;
}

export function protectSavedRun(taskId: string, run: SavedRun): SavedRun {
  if (run.mode !== "legal") return run;
  const protection = legalProtection();
  const out = { ...run, prompt: "", effectivePrompt: "", history: [], checkpoint: undefined, missionCheckpoint: undefined } as SavedRun & { sealed?: SealedLegalPayload };
  out.sealed = protection.seal({ prompt: run.prompt, effectivePrompt: run.effectivePrompt, history: run.history, checkpoint: run.checkpoint, missionCheckpoint: run.missionCheckpoint }, `run|${taskId}`);
  return out;
}

export function openSavedRun(run: SavedRun): SavedRun {
  if (run.mode !== "legal" || !run.sealed) return run;
  const opened = legalProtection().open<Pick<SavedRun, "prompt" | "effectivePrompt" | "history" | "checkpoint" | "missionCheckpoint">>(run.sealed);
  const out = { ...run, ...opened };
  delete out.sealed;
  return out;
}
