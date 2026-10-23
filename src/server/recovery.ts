import type { ChatMessage } from "../ollama.js";
import type { ExecutionCheckpoint } from "../agent/checkpoint.js";
import type { EffortLevel, OutputType } from "../llm/router.js";

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
  /** Neo N10: the composer's output type ("auto" when unset). */
  outputType?: OutputType;
  /** Neo N10: the resolved effort level behind `effort` (fast|max|""). */
  routingEffort?: EffortLevel | "";
  workMode?: string;
  orchestrated: boolean;
  started: boolean;
  checkpoint?: ExecutionCheckpoint;
  /** Side-chat ("/btw") run: restricted to read-only inspection tools. */
  sideChat?: boolean;
  /**
   * Neo N6: a mission checkpoint is durable and independent of the orchestrator
   * checkpoint, so a mission survives a server restart even when no execution
   * checkpoint was written yet.
   */
  missionCheckpoint?: import("../agent/mission.js").MissionCheckpoint;
  /**
   * Neo N6: the mission run type lifts the fixed step cap; this records that the
   * queued/resumed run is a mission so a resume keeps the same run type.
   */
  mission?: boolean;
}
export function requiresReplayConfirmation(run: SavedRun): boolean {
  return run.checkpoint ? run.checkpoint.inFlight : run.started;
}
