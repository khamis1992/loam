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
  /** Sequence the durable event log assigned to this checkpoint when it was
   *  written (BUILD_SPEC §6.5). Undefined for a checkpoint that was never logged. */
  logSeq?: number;
  /** Event-log session this run was logged under, so a resume can check whether
   *  a tool call started without a terminal event. */
  logSessionId?: string;
}
