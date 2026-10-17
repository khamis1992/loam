import type { ChatMessage } from "../ollama.js";
import type { ExecutionCheckpoint } from "../agent/checkpoint.js";

export interface SavedRun {
  prompt: string;
  effectivePrompt: string;
  history: ChatMessage[];
  workspace: string;
  model?: string;
  projectId?: string | null;
  agentId?: string;
  mode?: string;
  effort?: string;
  orchestrated: boolean;
  started: boolean;
  checkpoint?: ExecutionCheckpoint;
}
export function requiresReplayConfirmation(run: SavedRun): boolean {
  return run.checkpoint ? run.checkpoint.inFlight : run.started;
}
