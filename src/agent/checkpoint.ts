import type { Plan } from "./planner.js";
import type { ToolTraceItem, Usage } from "./events.js";

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
}
