import { createTask, getTask, setTaskPrompt, type Task } from "./db.js";
import { getThread, setThread, touchMessage } from "./agentThreads.js";

export function taskForAgentMessage(agentId: string, text: string, title?: string): Task {
  const thread = getThread(agentId);
  const existing = thread ? getTask(thread.threadUid) : undefined;
  if (thread && existing) {
    setTaskPrompt(existing.id, text);
    touchMessage(agentId);
    return existing;
  }
  const task = createTask(text, title ?? text.slice(0, 80), null, agentId);
  setThread(agentId, task.id);
  touchMessage(agentId);
  return task;
}
