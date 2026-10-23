/**
 * MiroFish conversational surface.
 *
 * This module is the public entry point for the MiroFish chat tool and the HTTP
 * route. It owns three things:
 *
 *  - the active-session file (what the follow-up branches and `GET /api/mirofish/session` read),
 *  - the intent router wiring (`shouldAutoTriggerMirofishInChat`),
 *  - the `mirofish_chat` tool definition.
 *
 * The heavy lifting lives in the pipeline modules so no simulation result is
 * ever hard-coded here:
 *
 *  - `mirofish/followup.ts` routes follow-ups onto the active session,
 *  - `mirofish/seed.ts` resolves the locale/entities/personas from the brief,
 *  - `mirofish/simulate.ts` runs the agent loop and records every turn,
 *  - `mirofish/report.ts` computes the report numbers from that log.
 *
 * Both conversational branches run the same pipeline. The difference is only
 * whether a provider client is available: with one, every stage is model-backed;
 * without one, every stage takes its deterministic rule-based path and the report
 * says so. Nothing is ever invented.
 */
import fs from "node:fs";
import path from "node:path";
import { OllamaClient } from "../ollama.js";
import { num, str, type Tool, type ToolContext, type ToolResult } from "./registry.js";
import type { Config } from "../config.js";
import type { AgentEvent } from "../agent/events.js";
import { classifyWithSession, extractMirofishSettings } from "./mirofish/intent.js";
import {
  parseInjectedVariable,
  toLocationSetting,
  type MirofishRuntimeDeps,
} from "./mirofish/runBridge.js";
import { mirofishRoot, runMirofishFollowUp } from "./mirofish/followup.js";
import { runMirofishPipeline } from "./mirofish/pipeline.js";

export type { MirofishRuntimeDeps } from "./mirofish/runBridge.js";

export interface MirofishActiveSession {
  project_id: string;
  graph_id: string;
  simulation_id: string;
  report_id: string;
  target_name: string;
  target_path: string | null;
  simulation_requirement: string;
  rounds_completed: number;
  updated_at: string;
  /** Location the user named for the simulation (city/country/region), if any. */
  location?: { city: string | null; country: string | null; region: string | null };
}

/**
 * Optional runtime handle for the real path.
 *
 * A caller that has a config and a provider client can pass them in and get the
 * model-backed swarm simulation instead of the rule-based run. Anything omitted
 * falls back to the deterministic rule-based run, which never invents a result.
 */
export interface MirofishRuntimeOptions {
  cfg?: Config;
  ollama?: OllamaClient;
  /** Test seam: a deterministic caller replaces the whole provider chain. */
  caller?: import("./mirofish/model.js").ModelCaller;
  /** Run event bus: simulation progress is forwarded here as `simulation_progress`. */
  emit?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

/** Read the active session, or null when none has been persisted yet. */
export function loadActiveMirofishSession(workspace: string): MirofishActiveSession | null {
  const f = path.join(mirofishRoot(workspace), "active_session.json");
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as MirofishActiveSession;
  } catch {
    return null;
  }
}

function saveActiveSession(workspace: string, session: MirofishActiveSession): void {
  const f = path.join(mirofishRoot(workspace), "active_session.json");
  fs.writeFileSync(f, JSON.stringify(session, null, 2), "utf8");
}

/** Render an extracted location as a short human label. "Global" when unnamed. */
function locationLabel(loc: { city: string | null; country: string | null; region: string | null }): string {
  if (loc.city && loc.country) return `${loc.city}, ${loc.country}`;
  if (loc.city) return loc.city;
  if (loc.country) return loc.country;
  if (loc.region) return loc.region;
  return "Global";
}

/**
 * Check if a conversational chat prompt should trigger or pre-ground MiroFish Swarm Intelligence.
 */
export function shouldAutoTriggerMirofishInChat(prompt: string, workspace: string): boolean {
  const text = (prompt || "").trim();
  if (!text) return false;
  const active = loadActiveMirofishSession(workspace);
  return classifyWithSession(text, Boolean(active)) !== "unrelated";
}

function guessTarget(text: string, workspace: string): string {
  const words = text.split(/[\s,،"']+/).filter((w) => w.length >= 2 && !w.startsWith("-"));
  for (const w of words) {
    const candidate = path.join(workspace, w);
    if (fs.existsSync(candidate) && w !== ".manus" && w !== "node_modules") return candidate;
  }
  return "";
}

/** The result shape every conversational surface returns. */
export interface MirofishChatResult {
  ok: boolean;
  intent: string;
  reply: string;
  data: Record<string, unknown>;
}

/** The `SimulationVariable` an injected God's-eye variable produces. */
function injectedVariableOf(raw: string): import("./mirofish/types.js").SimulationVariable {
  const parsed = parseInjectedVariable(raw);
  return {
    name: parsed?.name ?? "value",
    baseline: parsed?.baseline ?? 0,
    scenario: parsed?.scenario ?? raw,
  };
}

/**
 * Full analysis: the real pipeline (seed -> simulate -> report).
 *
 * With a caller injected every stage is model-backed; without one the pipeline
 * degrades deterministically (rule-based seed, every agent-turn recorded as
 * skipped, and a report that says so). The report file, the event log and the
 * metrics file are all written by the pipeline itself.
 */
async function runMirofishFullAnalysis(
  workspace: string,
  opts: {
    message: string;
    target?: string;
    maxRounds?: number;
    injectedVariable?: string;
  },
  caller?: import("./mirofish/model.js").ModelCaller,
): Promise<MirofishChatResult> {
  const text = (opts.message || "").trim();
  const extracted = extractMirofishSettings(text);
  const location = toLocationSetting(extracted.location);
  const rounds = Math.max(1, Math.floor(opts.maxRounds ?? 3));

  const { writeLegacyProfiles } = await import("./mirofish/asyncRunner.js");
  const { resolveReportLanguage, renderReportReply } = await import("./mirofish/report.js");

  const simulation = await runMirofishPipeline({
    settings: {
      brief: text || "Analyze the product in the workspace",
      ...(Object.keys(location).length > 0 ? { location } : {}),
      ...(opts.target ? { docs: [opts.target] } : {}),
      rounds,
      agents: 12,
      ...(opts.injectedVariable ? { variable: injectedVariableOf(opts.injectedVariable) } : {}),
    },
    ...(caller ? { caller } : {}),
    workspace,
  });

  const targetName = simulation.entities.products[0]?.name ?? "the product";
  const reportPath = simulation.report.paths.markdown;
  const acted = simulation.simulation.arms.reduce(
    (sum, arm) => sum + arm.turns.filter((turn) => turn.ok).length,
    0,
  );

  // The legacy profile artifacts the UI and the follow-up branches read.
  writeLegacyProfiles(
    mirofishRoot(workspace),
    simulation.simulation.sessionId,
    simulation.personas as unknown as Array<Record<string, unknown>>,
    targetName,
  );

  const session: MirofishActiveSession = {
    project_id: `proj_${simulation.simulation.sessionId}`,
    graph_id: `mirofish_${simulation.simulation.sessionId}`,
    simulation_id: simulation.simulation.sessionId,
    report_id: `rep_${simulation.simulation.sessionId}`,
    target_name: targetName,
    target_path: opts.target || null,
    simulation_requirement: text || `Analyze ${targetName}`,
    rounds_completed: simulation.simulation.rounds,
    updated_at: new Date().toISOString(),
    ...(Object.keys(location).length > 0 ? { location: extracted.location } : {}),
  };
  saveActiveSession(workspace, session);

  const language = resolveReportLanguage(text, simulation.locale);
  const reply = renderReportReply({ report: simulation.report, language, reportPath });

  return {
    ok: true,
    intent: "full_application_analysis",
    reply,
    data: {
      ...session,
      target_path: opts.target || null,
      report_md_path: reportPath,
      profiles_count: simulation.personas.length,
      model_calls: simulation.simulation.modelCalls,
      model_unavailable: acted === 0,
      market_location: Object.keys(location).length > 0 ? locationLabel(extracted.location) : "Global",
    },
  };
}

export function runConversationalMirofish(
  workspace: string,
  opts: {
    message: string;
    target?: string;
    maxRounds?: number;
    injectedVariable?: string;
    runtime?: MirofishRuntimeOptions;
  },
): Promise<MirofishChatResult> {
  // Follow-ups (what-if, interview, roundtable, ...) route onto the active
  // session and mutate nothing else; everything else is a full analysis.
  const followUp = runMirofishFollowUp(workspace, opts);
  if (followUp) return Promise.resolve(followUp);

  const runtime = opts.runtime ?? {};
  const caller = runtime.caller;
  // With a config and a provider client we take the model-backed path; otherwise
  // the pipeline still runs, just without a model.
  if (runtime.cfg) {
    return runConversationalMirofishAsync(workspace, { ...opts, runtime });
  }
  return runMirofishFullAnalysis(workspace, opts, caller);
}

/**
 * Model-aware path: the same conversational surface, but the full analysis is
 * the real swarm simulation instead of the rule-based run.
 *
 * Only the full-analysis branch differs. Follow-ups (what-if, interview,
 * roundtable, auto-fix, ...) are handled by `runMirofishFollowUp`, the same
 * router the synchronous entry point uses, so a follow-up never starts a new
 * simulation and never clobbers the active session.
 */
export async function runConversationalMirofishAsync(
  workspace: string,
  opts: {
    message: string;
    target?: string;
    maxRounds?: number;
    injectedVariable?: string;
    runtime?: MirofishRuntimeOptions;
  },
): Promise<MirofishChatResult> {
  const runtime = opts.runtime ?? {};
  if (!runtime.cfg) {
    throw new Error("runConversationalMirofishAsync requires runtime.cfg (a Config)");
  }
  const text = (opts.message || "").trim();

  // Follow-ups route onto the active session before any model work. The router
  // only sees the caller's explicit `target`, matching the synchronous surface.
  const followUp = runMirofishFollowUp(workspace, {
    message: text,
    ...(opts.target ? { target: opts.target } : {}),
    ...(opts.maxRounds ? { maxRounds: opts.maxRounds } : {}),
    ...(opts.injectedVariable ? { injectedVariable: opts.injectedVariable } : {}),
  });
  if (followUp) return followUp;

  const { runConversationalMirofishAsync: runAsync } = await import("./mirofish/asyncRunner.js");
  return runAsync(
    workspace,
    {
      message: text,
      target: opts.target || guessTarget(text, workspace) || undefined,
      ...(opts.maxRounds ? { maxRounds: opts.maxRounds } : {}),
      ...(opts.injectedVariable ? { injectedVariable: opts.injectedVariable } : {}),
    },
    {
      cfg: runtime.cfg,
      workspace,
      ...(runtime.ollama ? { ollama: runtime.ollama } : {}),
      ...(runtime.caller ? { caller: runtime.caller } : {}),
      ...(runtime.emit ? { emit: runtime.emit } : {}),
      ...(runtime.signal ? { signal: runtime.signal } : {}),
    },
  );
}

export function mirofishTools(): Tool[] {
  return [
    {
      name: "mirofish_chat",
      description:
        "Conversational MiroFish Swarm Intelligence & Application Analysis Engine. Call this tool whenever the user asks in chat to analyze a product or market, ask 'what if', interview agents, run a roundtable debate, or export the swarm results.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "The user's conversational request, question, or 'what-if' scenario.",
          },
          target: {
            type: "string",
            description: "Optional path to the target application directory or file inside workspace.",
          },
          maxRounds: {
            type: "number",
            description: "Optional number of simulation rounds (default 3).",
          },
          injectedVariable: {
            type: "string",
            description: "Optional explicit God's-eye variable to inject into the simulation.",
          },
        },
        required: ["message"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const request = {
          message: str(args, "message"),
          target: str(args, "target") || undefined,
          maxRounds: num(args, "maxRounds", 3),
          injectedVariable: str(args, "injectedVariable") || undefined,
        };
        // When the context carries a provider client we take the model-aware
        // path; otherwise the pipeline still produces a real report from the
        // recorded simulation log, with every turn logged as skipped.
        const res = ctx.ollama
          ? await runConversationalMirofishAsync(ctx.workspace, {
              ...request,
              runtime: {
                cfg: ctx.cfg,
                ollama: ctx.ollama,
                emit: ctx.emit,
                ...(ctx.signal ? { signal: ctx.signal } : {}),
              },
            })
          : await runConversationalMirofish(ctx.workspace, request);
        return {
          ok: res.ok,
          content: `${res.reply}\n\n---\n${JSON.stringify(res.data, null, 2)}`,
        };
      },
    },
  ];
}

/** Kept for callers that build the location setting themselves. */
export { toLocationSetting };
