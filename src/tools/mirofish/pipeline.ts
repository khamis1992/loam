/**
 * MiroFish swarm simulation pipeline (seed -> simulate -> report).
 *
 * This is the one place the three stages are composed, so the `mirofish_chat`
 * tool, the HTTP route and the M7 end-to-end gate all exercise the same code:
 *
 *  - `seed.ts` resolves the locale, entities and personas from the brief,
 *  - `simulate.ts` runs the agent loop and records every turn,
 *  - `report.ts` computes every number from that log and writes the report.
 *
 * Every stage is model-backed when a {@link ModelCaller} is injected and falls
 * back to the deterministic rule-based path when it is not, so a run is always
 * honest about what it did.
 *
 * Nothing here hard-codes a result: no persona type, no price, no percentage.
 */
import fs from "node:fs";
import path from "node:path";
import { runSeed } from "./seed.js";
import { runSimulation } from "./simulate.js";
import { buildReport } from "./report.js";
import type {
  MirofishChatRequest,
  ModelCaller,
  ModelRole,
  PipelineInput,
  PipelineResult,
  SimulationSettings,
  SimulationVariable,
} from "./types.js";
import { extractMirofishSettings, type ExtractedVariable } from "./intent.js";
import { parseInjectedVariable, toLocationSetting } from "./runBridge.js";

export type PipelineStage = "seed" | "simulate" | "report";

/**
 * Per-stage capability flags. Every stage ships in M4, so the M7 end-to-end
 * gate turns its assertions on instead of skipping them.
 */
export const mirofishPipelineCapabilities: Record<PipelineStage, boolean> = {
  seed: true,
  simulate: true,
  report: true,
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

/** Root the MiroFish artifacts live in, created on demand. */
function mirofishRoot(workspace: string): string {
  const root = path.join(workspace, ".manus", "mirofish");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** The variable to stress, taken from the settings and re-checked against the brief. */
function resolveVariable(settings: SimulationSettings): SimulationVariable | undefined {
  const explicit = settings.variable;
  if (explicit) return explicit;
  const extracted = extractMirofishSettings(settings.brief).variables;
  return extracted.length > 0 ? toSimulationVariable(extracted[0]!) : undefined;
}

/** Map a free-form `{name, value}` pair onto the baseline/scenario variable shape. */
function toSimulationVariable(variable: ExtractedVariable): SimulationVariable {
  const parsed = parseInjectedVariable(variable.value);
  return {
    name: variable.name,
    baseline: parsed?.baseline ?? "current",
    scenario: parsed?.scenario ?? variable.value,
  };
}

/**
 * One model call as the pipeline recorded it: which stage made it, which model
 * answered, and whether it worked. Kept so the report can attribute itself.
 */
interface RecordedCall {
  role: ModelRole;
  model?: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** A caller wrapper that records every call for the audit trail. */
function auditingCaller(caller: ModelCaller, recorded: RecordedCall[]): ModelCaller {
  return {
    async chat(request) {
      const started = Date.now();
      try {
        const response = await caller.chat(request);
        recorded.push({
          role: request.role ?? "simulate",
          ...(response.model ? { model: response.model } : {}),
          ok: true,
          latencyMs: Date.now() - started,
        });
        return response;
      } catch (err) {
        recorded.push({
          role: request.role ?? "simulate",
          ok: false,
          latencyMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };
}

/** The model that actually answered, when one did (used for report attribution). */
function answeringModel(recorded: RecordedCall[]): string | null {
  for (let i = recorded.length - 1; i >= 0; i--) {
    const model = recorded[i]?.model;
    if (model) return model;
  }
  return null;
}

/**
 * Core pipeline: seed (entities + locale + personas) -> simulate (rounds, event
 * log, per-round metrics) -> report (numbers computed from the log). Backed by
 * the injected {@link ModelCaller}.
 */
export async function runMirofishPipeline(input: PipelineInput): Promise<PipelineResult> {
  const root = mirofishRoot(input.workspace);
  const recorded: RecordedCall[] = [];
  // Without a caller every stage takes its deterministic rule-based path, so a
  // run still completes and still reports honestly that no model was used.
  const caller = input.caller ? auditingCaller(input.caller, recorded) : undefined;

  const variable = resolveVariable(input.settings);
  const rounds = Math.max(1, Math.floor(input.settings.rounds ?? 3));
  const concurrency = input.concurrency ?? 2;
  input.onProgress?.({ stage: "seed", message: "resolving locale, entities and personas" });

  const seedResult = await runSeed(input.settings, {
    caller,
    workspace: input.workspace,
    concurrency,
    ...(input.settings.language ? { language: input.settings.language } : {}),
  });

  const sessionId = `sim_${Date.now().toString(36)}`;
  const simDir = path.join(root, "simulations", sessionId);
  fs.mkdirSync(simDir, { recursive: true });

  input.onProgress?.({ stage: "simulate", message: `running ${rounds} round(s) of agent turns` });
  const simulation = await runSimulation(
    sessionId,
    { seed: seedResult, brief: input.settings.brief, ...(variable ? { variable } : {}) },
    {
      caller,
      seed: input.settings.seed,
      agents: input.settings.agents,
      rounds,
      concurrency,
      taskDir: simDir,
      ...(input.settings.language ? { language: input.settings.language } : {}),
    },
  );

  input.onProgress?.({ stage: "report", message: "computing the report from the simulation log" });
  const acted = simulation.arms.reduce((sum, arm) => sum + arm.turns.filter((turn) => turn.ok).length, 0);
  const { report } = await buildReport({
    ...(caller ? { caller } : {}),
    brief: input.settings.brief,
    targetName: seedResult.entities.products[0]?.name ?? "the product",
    locale: seedResult.locale,
    entities: seedResult.entities,
    personas: seedResult.personas,
    simulation,
    ...(simulation.comparison ? { comparison: simulation.comparison } : {}),
    ...(input.settings.language ? { language: input.settings.language } : {}),
    modelUnavailable: acted === 0,
    model: answeringModel(recorded),
  });
  // The report lives next to the log it cites, so `report.paths.markdown` is a
  // real file rather than a promise.
  fs.mkdirSync(path.dirname(report.paths.markdown), { recursive: true });
  fs.writeFileSync(report.paths.markdown, report.markdown, "utf8");

  return {
    settings: input.settings,
    locale: seedResult.locale,
    entities: seedResult.entities,
    personas: seedResult.personas,
    simulation,
    report,
    modelCalls: recorded,
  };
}

/**
 * Conversational entry point used by the `mirofish_chat` tool and the e2e gate.
 * When `settings` is omitted the seed stage derives them from `message`/`target`.
 */
export async function runMirofishChat(request: MirofishChatRequest): Promise<PipelineResult> {
  const settings = request.settings ?? settingsFromMessage(request.message, request.target);
  return runMirofishPipeline({
    settings,
    caller: request.caller,
    workspace: request.workspace,
    ...(request.concurrency ? { concurrency: request.concurrency } : {}),
    ...(request.onProgress ? { onProgress: request.onProgress } : {}),
  });
}

/**
 * Derive settings from a free-form message: the brief is the message, the
 * location and variable are extracted by the same intent module the tool uses,
 * and the target path only matters for the artifact layout.
 */
export function settingsFromMessage(message: string, target?: string): SimulationSettings {
  const extracted = extractMirofishSettings(message);
  const variable = extracted.variables.length > 0 ? toSimulationVariable(extracted.variables[0]!) : undefined;
  return {
    brief: message.trim() || "Analyze the product in the workspace",
    ...(Object.keys(toLocationSetting(extracted.location)).length > 0
      ? { location: toLocationSetting(extracted.location) }
      : {}),
    ...(variable ? { variable } : {}),
    ...(target ? { docs: [target] } : {}),
  };
}
