/**
 * MiroFish swarm simulation pipeline entry points.
 *
 * M7 ships only the capability gate and the public interfaces. The stages
 * themselves (seed -> simulate -> report) are implemented by the later tasks;
 * until then every entry point throws {@link MirofishPipelineUnavailableError}
 * and {@link mirofishPipelineReady} reports false so the e2e gate skips its
 * assertions instead of failing on the still-fake legacy tool.
 */
import type {
  MirofishChatRequest,
  PipelineInput,
  PipelineResult,
} from "./types.js";
import { MirofishPipelineUnavailableError } from "./types.js";

export type PipelineStage = "seed" | "simulate" | "report";

/**
 * Per-stage capability flags. A stage task flips its own flag to true once the
 * stage is implemented, which turns on the matching e2e assertions.
 */
export const mirofishPipelineCapabilities: Record<PipelineStage, boolean> = {
  seed: false,
  simulate: false,
  report: false,
};

export function mirofishStageReady(stage: PipelineStage): boolean {
  return mirofishPipelineCapabilities[stage];
}

/** True only when every stage is implemented. */
export function mirofishPipelineReady(): boolean {
  return (Object.keys(mirofishPipelineCapabilities) as PipelineStage[]).every(
    (stage) => mirofishPipelineCapabilities[stage],
  );
}

/**
 * Core pipeline: seed (entities + locale + personas) -> simulate (rounds, event
 * log, per-round metrics) -> report (numbers computed from the log). Backed by
 * the injected {@link ModelCaller}.
 */
export async function runMirofishPipeline(input: PipelineInput): Promise<PipelineResult> {
  if (!mirofishPipelineReady()) {
    throw new MirofishPipelineUnavailableError("pipeline");
  }
  // Implemented by the seed / simulate / report stage tasks.
  throw new MirofishPipelineUnavailableError("pipeline");
}

/**
 * Conversational entry point used by the `mirofish_chat` tool and the e2e gate.
 * When `settings` is omitted the seed stage derives them from `message`/`target`.
 */
export async function runMirofishChat(request: MirofishChatRequest): Promise<PipelineResult> {
  if (!request.settings) {
    throw new MirofishPipelineUnavailableError("seed");
  }
  return runMirofishPipeline({
    settings: request.settings,
    caller: request.caller,
    workspace: request.workspace,
    onProgress: request.onProgress,
  });
}
