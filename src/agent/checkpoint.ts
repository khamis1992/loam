import type { Plan } from "./planner.js";
import type { ToolTraceItem, Usage } from "./events.js";
import type { ChatMessage } from "../ollama.js";

/** A completed tool batch, never a promise that an in-flight effect is atomic. */
export interface WorkerCheckpoint {
  prompt: string;
  messages: ChatMessage[];
  trace: ToolTraceItem[];
  steps: number;
  model: string;
  usage: Usage;
}

export interface ExecutionCheckpoint {
  version: 1;
  plan: Plan;
  nextStep: number;
  completed: string[];
  lastText: string;
  trace: ToolTraceItem[];
  round: number;
  usage: Usage;
  totalSteps: number;
  model: string;
  inFlight: boolean;
  complete: boolean;
  finalRepairUsed: boolean;
  /** Bounded final-repair attempts, persisted so resume cannot reset the limit. */
  finalRepairAttempts?: number;
  /** Pending final-repair instruction, retained across a process restart. */
  finalRepairPrompt?: string;
  acceptanceContract?: string;
  independentAcceptance?: string;
  independentRequirements?: string;
  fileOnlyTools?: boolean;
  worker?: WorkerCheckpoint;
}
