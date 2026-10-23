/**
 * Async MiroFish orchestrator (M3 wiring).
 *
 * `runConversationalMirofish` in `src/tools/mirofish.ts` stays a plain,
 * synchronous, dependency-free function so every existing caller (HTTP route,
 * tool registry, tests) keeps working unchanged. This module is the async half:
 * it runs the real M2 seed + M3 simulation, writes the legacy artifacts the UI
 * already reads (profile JSON/CSV, report.md, active session), and reports
 * progress on the run's event bus.
 *
 * Nothing is fabricated. When no model is reachable the run still completes with
 * the deterministic rule-based personas, every agent-turn is recorded as skipped
 * (`ok:false`), and the reply carries a plain methodology warning.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createLoamModelCaller, type ModelCaller } from "./model.js";
import { extractMirofishSettings, type MirofishIntentKind } from "./intent.js";
import {
  fallbackSeed,
  parseInjectedVariable,
  toLocationSetting,
  type MirofishRuntimeDeps,
  type MirofishRunRequest,
} from "./runBridge.js";
import {
  DEFAULT_RUN_AGENTS,
  DEFAULT_RUN_CALL_TIMEOUT_MS,
  DEFAULT_RUN_CONCURRENCY,
  renderSwarmReport,
  renderSwarmReply,
  runSeedValue,
  writeSeedArtifact,
  type SwarmRun,
} from "./runner.js";
import { runSeed } from "./seed.js";
import type { SimulationProgressEvent } from "./types.js";

/** One allocated set of artifact ids for a run. */
export interface MirofishIds {
  projectId: string;
  graphId: string;
  simulationId: string;
  reportId: string;
}

/** The result of an async MiroFish run, shaped for the conversational surface. */
export interface AsyncMirofishResult {
  ok: boolean;
  intent: MirofishIntentKind;
  reply: string;
  data: Record<string, unknown>;
}

/** The extra options the async path needs beyond the sync signature. */
export interface AsyncMirofishOptions {
  message: string;
  target?: string;
  maxRounds?: number;
  injectedVariable?: string;
  /** Model-derived language hint ("auto" or a BCP-47 tag). */
  language?: string;
  /** Cancellation signal from the surrounding run. */
  signal?: AbortSignal;
  /** Test seam: a deterministic caller replaces the whole provider chain. */
  caller?: ModelCaller;
}

/** Root the MiroFish artifacts live in, created on demand. */
export function mirofishRoot(workspace: string): string {
  const root = path.join(workspace, ".manus", "mirofish");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** Resolve the model caller for the async path. */
export function resolveCaller(deps: MirofishRuntimeDeps): ModelCaller | undefined {
  if (deps.caller) return deps.caller;
  if (!deps.ollama) return undefined;
  return createLoamModelCaller(deps.cfg, deps.ollama);
}

/** Build the progress sink that forwards M3 events onto the run's event bus. */
export function progressSink(emit: MirofishRuntimeDeps["emit"], simulationId: string) {
  return (event: SimulationProgressEvent): void => {
    if (!emit) return;
    try {
      emit({ type: "simulation_progress", sessionId: simulationId, payload: event });
    } catch {
      /* progress reporting must never break the run */
    }
  };
}

/**
 * Persist the active MiroFish session so the follow-up branches (what-if,
 * interview, roundtable) and `GET /api/mirofish/session` keep working.
 *
 * Deliberately duplicated from `src/tools/mirofish.ts` rather than imported:
 * that module must stay synchronous and model-free, so it can never be a
 * dependency of this one.
 */
export function saveActiveMirofishSessionAsync(
  workspace: string,
  session: {
    project_id: string;
    graph_id: string;
    simulation_id: string;
    report_id: string;
    target_name: string;
    target_path: string | null;
    simulation_requirement: string;
    rounds_completed: number;
    updated_at: string;
    location?: { city: string | null; country: string | null; region: string | null };
  },
): void {
  const root = mirofishRoot(workspace);
  fs.writeFileSync(
    path.join(root, "active_session.json"),
    JSON.stringify(session, null, 2),
    "utf8",
  );
}

/**
 * Run the real swarm simulation behind a conversational request and return the
 * reply plus the same `data` payload shape the synchronous runner has always
 * produced.
 */
export async function runConversationalMirofishAsync(
  workspace: string,
  opts: AsyncMirofishOptions,
  deps: MirofishRuntimeDeps,
): Promise<AsyncMirofishResult> {
  const root = mirofishRoot(workspace);
  const text = (opts.message || "").trim();
  const isAr = /[\u0600-\u06FF]/.test(text);
  const settings = extractMirofishSettings(text);
  const location = settings.location;
  const caller = resolveCaller(deps);
  const variable = parseInjectedVariable(opts.injectedVariable ?? "");

  const ids: MirofishIds = {
    projectId: `proj_${crypto.randomBytes(5).toString("hex")}`,
    graphId: `mirofish_${crypto.randomBytes(6).toString("hex")}`,
    simulationId: `sim_${crypto.randomBytes(5).toString("hex")}`,
    reportId: `rep_${crypto.randomBytes(5).toString("hex")}`,
  };

  const { run, seedResult } = await simulateRequest(
    deps,
    {
      message: text,
      ...(opts.target ? { target: opts.target } : {}),
      ...(opts.maxRounds ? { maxRounds: opts.maxRounds } : {}),
      ...(opts.injectedVariable ? { injectedVariable: opts.injectedVariable } : {}),
      ...(opts.language ? { language: opts.language } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      simulationId: ids.simulationId,
    },
    root,
  );

  const targetName = seedResult.entities.products[0]?.name ?? "the product";
  // Same seed artifact the synchronous runner leaves, so both surfaces expose
  // the resolved locale, entities and personas.
  writeSeedArtifact(path.join(root, "seeds"), seedResult);
  writeLegacyProfiles(
    root,
    ids.simulationId,
    run.seedResult.personas as unknown as Array<Record<string, unknown>>,
    targetName,
  );

  const { reportPath, reply } = renderRun(
    run,
    { message: text, location },
    root,
    { ...ids, targetName },
    isAr,
  );

  saveActiveMirofishSessionAsync(workspace, {
    project_id: ids.projectId,
    graph_id: ids.graphId,
    simulation_id: ids.simulationId,
    report_id: ids.reportId,
    target_name: targetName,
    target_path: null,
    simulation_requirement: text || `Analyze ${targetName}`,
    rounds_completed: run.simulation?.rounds ?? 0,
    updated_at: new Date().toISOString(),
    ...(location.city || location.country || location.region ? { location } : {}),
  });

  return {
    ok: true,
    // Follow-up intents are routed before this runner is reached (see
    // `runMirofishFollowUp`), so anything that arrives here and actually runs a
    // simulation is a full analysis. Reporting the raw classification would
    // label unrelated text "unrelated" even though a simulation just ran.
    intent: "full_application_analysis",
    reply,
    data: {
      project_id: ids.projectId,
      graph_id: ids.graphId,
      simulation_id: ids.simulationId,
      report_id: ids.reportId,
      target_name: targetName,
      target_path: null,
      simulation_requirement: text,
      rounds_completed: run.simulation?.rounds ?? 0,
      updated_at: new Date().toISOString(),
      ...(location.city || location.country || location.region ? { location } : {}),
      report_md_path: reportPath,
      profiles_count: run.personaCount,
      model_calls: run.simulation?.modelCalls ?? 0,
      model_unavailable: run.modelUnavailable,
    },
  };
}

/**
 * Run the M2 seed + M3 simulation for one request and leave the artifacts on
 * disk under `root`. Exported so tests and the HTTP route can drive it directly.
 */
export async function simulateRequest(
  deps: MirofishRuntimeDeps,
  request: {
    message: string;
    target?: string;
    maxRounds?: number;
    injectedVariable?: string;
    language?: string;
    signal?: AbortSignal;
    simulationId: string;
    location?: { city: string | null; country: string | null; region: string | null };
  },
  root: string,
): Promise<{ run: SwarmRun; seedResult: SwarmRun["seedResult"] }> {
  const text = (request.message || "").trim();
  const settings = extractMirofishSettings(text);
  const location = request.location ?? settings.location;
  const caller = resolveCaller(deps);
  const variable = parseInjectedVariable(request.injectedVariable ?? "");
  const rounds = Math.max(1, Math.floor(request.maxRounds ?? 3));
  const agents = Math.max(1, Math.floor(DEFAULT_RUN_AGENTS));
  const rngSeed = runSeedValue(text);

  const seedResult = caller
    ? await runSeed(
        {
          brief: text,
          ...(Object.keys(toLocationSetting(location)).length > 0
            ? { location: toLocationSetting(location) }
            : {}),
          agents,
          rounds,
          ...(variable ? { variable } : {}),
          ...(request.language ? { language: request.language } : {}),
          seed: rngSeed,
        },
        { caller, workspace: deps.workspace, concurrency: DEFAULT_RUN_CONCURRENCY },
      )
    : await fallbackSeed(deps.workspace, text, location, agents);

  const simDir = path.join(root, "simulations", request.simulationId);
  const { runSimulation } = await import("./simulate.js");
  const simulation = await runSimulation(
    request.simulationId,
    { seed: seedResult, brief: text, ...(variable ? { variable } : {}) },
    {
      caller,
      seed: rngSeed,
      agents,
      rounds,
      concurrency: DEFAULT_RUN_CONCURRENCY,
      perCallTimeoutMs: DEFAULT_RUN_CALL_TIMEOUT_MS,
      taskDir: simDir,
      ...(request.language ? { language: request.language } : {}),
      onProgress: progressSink(deps.emit, request.simulationId),
      ...(request.signal ? { signal: request.signal } : {}),
    },
  );

  const acted = simulation.arms.reduce((sum, arm) => sum + arm.turns.filter((t) => t.ok).length, 0);

  return {
    run: {
      ok: true,
      seedResult,
      simulation,
      modelUnavailable: acted === 0,
      ...(simulation.comparison ? { comparison: simulation.comparison } : {}),
      personaCount: seedResult.personas.length,
    },
    seedResult,
  };
}

/**
 * Write the legacy profile artifacts (Reddit JSON + Twitter CSV) that the UI
 * and the M5 follow-up branches already read, from the personas a run produced.
 */
export function writeLegacyProfiles(
  root: string,
  simulationId: string,
  personas: Array<Record<string, unknown>>,
  targetName: string,
): { redditProfilesPath: string; twitterProfilesPath: string } {
  const simDir = path.join(root, "simulations", simulationId);
  fs.mkdirSync(path.join(simDir, "twitter"), { recursive: true });
  fs.mkdirSync(path.join(simDir, "reddit"), { recursive: true });

  const profiles = personas.map((p, idx) => ({
    user_id: idx,
    username:
      typeof p.name === "string" && p.name ? p.name.toLowerCase().replace(/\s+/g, "_") : `agent_${100 + idx}`,
    name: typeof p.name === "string" && p.name ? p.name : `${targetName} Agent ${idx + 1}`,
    bio: typeof p.bio === "string" && p.bio ? p.bio : "",
    persona:
      typeof p.occupation === "string" && p.occupation
        ? `${p.occupation} evaluating ${targetName}`
        : `Agent evaluating ${targetName}`,
    age: typeof p.age === "number" ? p.age : 30,
    gender: typeof p.gender === "string" && p.gender ? p.gender : idx % 2 === 0 ? "female" : "male",
    mbti: "INTJ",
    country: typeof p.country === "string" && p.country ? p.country : "Global",
    profession: typeof p.occupation === "string" && p.occupation ? p.occupation : targetName,
  }));

  const redditProfilesPath = path.join(simDir, "reddit_profiles.json");
  fs.writeFileSync(redditProfilesPath, JSON.stringify(profiles, null, 2), "utf8");

  const csvHeader = "user_id,name,username,user_char,description\n";
  const csvRows = profiles.map((p) => `${p.user_id},"${p.name}","${p.username}","${p.persona}","${p.bio}"`).join("\n");
  const twitterProfilesPath = path.join(simDir, "twitter_profiles.csv");
  fs.writeFileSync(twitterProfilesPath, csvHeader + csvRows + "\n", "utf8");

  return { redditProfilesPath, twitterProfilesPath };
}

/** Render the report and reply for a completed run. */
export function renderRun(
  run: SwarmRun,
  request: MirofishRunRequest,
  root: string,
  ids: { simulationId: string; reportId: string; graphId: string; targetName: string },
  isAr: boolean,
): { reportPath: string; reply: string } {
  const reportPath = path.join(root, "reports", ids.reportId, "report.md");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const report = renderSwarmReport({
    run,
    message: request.message,
    isAr,
    location: request.location ?? { city: null, country: null, region: null },
    targetName: ids.targetName,
    graphId: ids.graphId,
    reportId: ids.reportId,
  });
  fs.writeFileSync(reportPath, report, "utf8");

  const reply = renderSwarmReply({
    run,
    message: request.message,
    isAr,
    location: request.location ?? { city: null, country: null, region: null },
    targetName: ids.targetName,
    reportPath,
    reportId: ids.reportId,
    graphId: ids.graphId,
  });

  return { reportPath, reply };
}
