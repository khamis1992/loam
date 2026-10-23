/**
 * The N20 long-horizon harness.
 *
 * This is the piece that makes the gate real instead of theoretical: it drives
 * the production agent loop (`src/agent/loop.ts`) with a scripted
 * {@link NeoMockModel}, so a fixture exercises the same system-prompt assembly,
 * tool dispatch, stall guard, step budget, checkpoint resume and final
 * verification the app uses. Nothing here mocks the loop.
 *
 * What is substituted on purpose:
 *   - the model client (scripted, deterministic, offline)
 *   - the clock (virtual, advanced by the fixture)
 *   - fault injection (a fixture's `onCall` hook, applied before the real tool)
 *
 * A case runs in its own temporary workspace. Nothing is written outside it, no
 * network is touched, and no real model is called.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runAgent } from "../agent/loop.js";
import { isCancelledError } from "../server/runControl.js";
import type { ToolTraceItem } from "../agent/events.js";
import { ToolRegistry, num, str, type Tool, type ToolContext, type ToolResult } from "../tools/registry.js";
import { fileTools } from "../tools/files.js";
import type { Config } from "../config.js";
import type { OllamaClient } from "../ollama.js";
import { KnowledgeStore, extractCitations } from "./knowledge.js";
import { NeoMockModel } from "./mockModel.js";
import { MockClock } from "./mockClock.js";
import { scoreArtifacts, type ScoreInputs } from "./scoring.js";
import type { NeoFixture, NeoModelScript, NeoRunResult, NeoScriptStep, NeoTraceItem } from "./types.js";

/**
 * The mock is a structural stand-in for {@link OllamaClient}. That class is
 * nominally typed (it declares a private field), so an unrelated class can never
 * satisfy it directly; the cast is confined to this injection boundary, which is
 * the same convention the agent loop's own tests use for their fake clients.
 */
function asClient(model: NeoMockModel): OllamaClient {
  return model as unknown as OllamaClient;
}

/** Default tool set: the production file tools plus the eval's knowledge lookup. */
const DEFAULT_TOOLS = [...new Set([...fileTools.map((t) => t.name), "kb_search"])];

/** Every production file tool, keyed by name. */
const REGISTERED: Record<string, Tool> = Object.fromEntries(fileTools.map((t) => [t.name, t]));

/**
 * The knowledge lookup the eval provides to every case that declares seeds.
 *
 * Retrieval is the production-shaped contract the fixtures rely on: hits are
 * ranked by {@link KnowledgeStore.search} and every hit carries its seed id in
 * the `[seed:ID]` form the citation scorer expects.
 */
function kbSearchTool(store: KnowledgeStore): Tool {
  return {
    name: "kb_search",
    description:
      "Search the knowledge base for documents relevant to a question. Returns ranked hits with their seed ids; cite a hit as [seed:ID] in the answer.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms." },
        limit: { type: "number", description: "Maximum hits (default 5)." },
      },
      required: ["query"],
    },
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      const query = str(args, "query");
      const limit = Math.max(1, num(args, "limit", 5));
      const result = store.search(query, limit);
      if (result.empty) return { ok: true, content: `no knowledge matches for "${query}"` };
      const lines = result.hits.flatMap((hit) => {
        const seed = store.get(hit.id);
        return [
          `[seed:${hit.id}] score=${hit.score} matched=${hit.matched.join(",") || "none"} tags=${(seed?.tags ?? []).join(",") || "none"}`,
          seed?.body ?? "",
        ];
      });
      return { ok: true, content: `knowledge hits for "${query}":\n${lines.join("\n\n")}` };
    },
  };
}

/** Minimal config for a case: offline, no compression, no per-edit diagnostics. */
export function neoConfig(workspace: string, model: string): Config {
  return {
    model,
    fallbackModel: model,
    ollamaUrl: "neo://mock",
    agent: { maxSteps: 40, temperature: 0, requestTimeoutMs: 5_000 },
    workspace,
    policy: {
      networkEnabled: false,
      allowOutsideWorkspaceRead: false,
      denyCommandPatterns: [],
      allowCommandPatterns: [],
      maxCommandSeconds: 5,
      sandboxMode: "workspace-write",
    },
    browser: { channel: "", headless: true, viewport: { width: 1, height: 1 } },
    computerUse: { enabled: false, screenshotDir: path.join(workspace, ".screenshots") },
    memory: {
      enabled: false,
      model: "",
      file: path.join(workspace, "memory.json"),
      autoStore: false,
      recallTop: 0,
      minScore: 1,
      maxEntries: 0,
      dedupeThreshold: 1,
    },
    screen: { enabled: false, fps: 1, quality: 1, maxWidth: 1 },
    vision: { enabled: false, maxImagesPerStep: 0 },
    selfImprove: { enabled: false, reviewEvery: 0, model: "", maxSteps: 1, writeApproval: true },
    evaluation: { enabled: false, intervalMinutes: 0, suite: "", critique: false, keepRuns: 0, transcripts: false },
    selfPlay: { maxCases: 0 },
    orchestrator: {
      enabled: false,
      plannerModel: "",
      verifierModel: "",
      maxPlanSteps: 1,
      maxStepsPerWorker: 1,
      maxRevisionsPerStep: 1,
      maxReplans: 0,
      verifyFinal: true,
    },
    subagent: { maxDepth: 0, maxConcurrentChildren: 0 },
    mcpServers: {},
    compression: {
      enabled: false,
      thresholdPercent: 1,
      protectLead: 999,
      protectTail: 999,
      targetRatio: 1,
      model: "",
      contextWindow: {},
    },
    sessionLog: { enabled: false },
    diagnostics: { enabled: false, timeoutMs: 1000, maxErrors: 0, checker: "tsc" },
  } as unknown as Config;
}

/**
 * Build the tool registry for a case.
 *
 * `file_read` is wrapped so a verifier script can name the artifact with the
 * placeholder `REPORT_PATH` instead of hard-coding a fixture-specific filename;
 * every other call goes straight through to the production tool.
 */
export function buildRegistry(fixture: NeoFixture, store: KnowledgeStore): ToolRegistry {
  const wanted = fixture.tools ?? DEFAULT_TOOLS;
  const registry = new ToolRegistry();
  const readTool = REGISTERED["file_read"];

  for (const name of wanted) {
    const base = REGISTERED[name];
    if (base) {
      if (name !== "file_read") {
        registry.register(base);
        continue;
      }
      if (!readTool) continue;
      registry.register({
        ...readTool,
        async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
          if (str(args, "path") === "REPORT_PATH") {
            const capture = fixture.capture?.[0];
            if (!capture) return { ok: false, content: "fixture declares no capture path" };
            return readTool.run({ ...args, path: capture }, ctx);
          }
          return readTool.run(args, ctx);
        },
      });
      continue;
    }
    if (name === "kb_search") {
      registry.register(kbSearchTool(store));
      continue;
    }
    // Unknown names are ignored so a fixture can list a tool this build does
    // not ship without failing the whole suite.
  }
  return registry;
}

export interface RunFixtureOptions {
  /** Fixture to run. */
  fixture: NeoFixture;
  /** Workspace root; a fresh temp directory is created when omitted. */
  workspace?: string;
  /** Keep the workspace on disk after the run (default false). */
  keepWorkspace?: boolean;
}

export interface FixtureRunOutcome {
  result: NeoRunResult;
  workspace: string;
  model: NeoMockModel;
}

/**
 * Run one fixture to completion and collect the evidence the scorer needs.
 *
 * A recurring fixture runs one agent round per declared `rounds` entry on the
 * virtual clock. Each round is a fresh run against the same workspace, which is
 * what makes the case measure *persistence across rounds* rather than a single
 * long transcript.
 */
export async function runFixture(options: RunFixtureOptions): Promise<FixtureRunOutcome> {
  const fixture = options.fixture;
  const owned = options.workspace === undefined;
  const workspace =
    options.workspace ?? fs.mkdtempSync(path.join(os.tmpdir(), `neo-${fixture.id.replace(/[^a-z0-9-]/gi, "")}-`));
  fs.mkdirSync(workspace, { recursive: true });

  for (const seed of fixture.seedFiles ?? []) {
    const full = path.resolve(workspace, seed.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, seed.text, "utf8");
  }

  const store = new KnowledgeStore(fixture.seeds ?? []);
  const registry = buildRegistry(fixture, store);
  const model = new NeoMockModel({
    script: fixture.script,
    verifierScript: fixture.verifierScript ?? defaultVerifierScript(fixture),
    model: fixture.config?.model ?? "neo-mock",
    workspace,
    growthPerStep: fixture.config?.growthPerStep ?? 0,
    // The harness already observes and injects calls (see the `observing`
    // registry below), so the mock must not inject a second time: doing so would
    // record the same call twice in the mock's own log and let a failure reach
    // the production tool. The hook stays on the type for callers that drive the
    // mock directly.
    onCall: undefined,
  });

  const clock = new MockClock(fixture.rounds?.[0]?.at ?? "2026-01-05T09:00:00Z");
  const rounds = fixture.rounds ?? [{ at: clock.iso(), name: "round-1" }];

  const trace: NeoTraceItem[] = [];
  const files: Record<string, string> = {};
  const captureTargets = new Set([
    ...(fixture.capture ?? []),
    ...(fixture.asserts ?? [])
      .map((a) => ("path" in a ? a.path : undefined))
      .filter((p): p is string => Boolean(p)),
  ]);

  let finalText = "";
  let steps = 0;
  let roundsRun = 0;
  let resumedFrom = false;
  let callsAfterResume = 0;
  let budgetExhausted = false;

  // The wrapper registry observes every call (for the trace and for fault
  // injection) and then delegates to the production tool.
  const observing = new ToolRegistry();
  for (const name of registry.names()) {
    const tool = registry.get(name)!;
    observing.register({
      ...tool,
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const dispatched = trace.length;
        const injected = fixture.script.onCall?.(tool.name, args, {
          atStep: steps,
          calls: dispatched,
          fileExists: (p) => (p ? fs.existsSync(path.isAbsolute(p) ? p : path.resolve(ctx.workspace, p)) : false),
        });
        if (injected !== undefined) {
          trace.push({ name: tool.name, ok: false, summary: injected, args });
          return { ok: false, content: injected };
        }
        const result = await tool.run(args, ctx);
        trace.push({ name: tool.name, ok: result.ok, summary: result.content, args });
        if (result.ok) capture(workspace, args, captureTargets, files);
        return result;
      },
    });
  }

  for (const round of rounds) {
    // Each round is a fresh agent run, so the scripted model replays its script
    // from the first turn rather than continuing past the end of the last round.
    model.resetForRound();
    clock.advanceTo(round.at);
    const roundTraceStart = trace.length;
    const roundPrompt = round.prompt ?? fixture.prompt;
    const cfg = neoConfig(workspace, fixture.config?.model ?? "neo-mock");

    // Restart-from-step: the run is interrupted once the fixture's interrupt
    // point is reached, then resumed from the checkpoint the loop saved at the
    // end of that step. The interrupt is a real abort of the run signal — the
    // production mechanism for "the run was stopped" — and the loop keeps its
    // safe boundary, so the resume replays the transcript instead of restarting.
    const controller = new AbortController();
    let checkpoint: import("../agent/checkpoint.js").WorkerCheckpoint | undefined;
    let interrupted = false;

    const maybeInterrupt = (): void => {
      const limit = fixture.interruptAfter;
      if (interrupted || limit === undefined || trace.length < limit) return;
      interrupted = true;
      controller.abort();
    };

    const observe = (item: ToolTraceItem): void => {
      if (item.ok && typeof (item.args as Record<string, unknown> | undefined)?.["path"] === "string") {
        capture(workspace, item.args as Record<string, unknown>, captureTargets, files);
      }
    };

    try {
      const outcome = await runAgent({
        cfg,
        ollama: asClient(model),
        tools: observing,
        prompt: roundPrompt,
        emit: () => {},
        signal: controller.signal,
        ...(fixture.maxSteps ? { maxSteps: fixture.maxSteps } : {}),
        ...(fixture.system ? { systemOverride: fixture.system } : {}),
        onToolEvidence: observe,
        saveWorker: (saved) => {
          checkpoint = saved;
          if (saved) maybeInterrupt();
        },
      });
      finalText = outcome.text;
      steps = Math.max(steps, outcome.steps);
      roundsRun += 1;
      continue;
    } catch (error) {
      // Only an interrupt at the fixture's declared point is a restart; anything
      // else is a genuine failure and is recorded as such.
      if (!interrupted || !isCancelledError(error) || !checkpoint) {
        const message = error instanceof Error ? error.message : String(error);
        budgetExhausted = /stopped after \d+ steps without finishing/.test(message);
        trace.push({ name: "run", ok: false, summary: message });
        continue;
      }
    }

    // Resume from the saved checkpoint. The abort is deliberately not forwarded:
    // a resumed worker is a fresh execution continuing the saved transcript,
    // and `suppressFinal` keeps the loop from re-running the final gate on a
    // worker that has no completed answer of its own to judge.
    resumedFrom = true;
    try {
      const resumed = await runAgent({
        cfg,
        ollama: asClient(model),
        tools: observing,
        prompt: roundPrompt,
        emit: () => {},
        ...(fixture.maxSteps ? { maxSteps: fixture.maxSteps } : {}),
        ...(fixture.system ? { systemOverride: fixture.system } : {}),
        resumeWorker: checkpoint,
        suppressFinal: true,
        onToolEvidence: observe,
      });
      finalText = resumed.text;
      steps = Math.max(steps, resumed.steps);
      callsAfterResume = trace.length - roundTraceStart;
      roundsRun += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      budgetExhausted = /stopped after \d+ steps without finishing/.test(message);
      trace.push({ name: "run", ok: false, summary: message });
    }
  }

  // Read back whatever the agent wrote, even if the trace missed it.
  for (const target of captureTargets) {
    if (files[target] !== undefined) continue;
    const full = path.resolve(workspace, target);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) files[target] = fs.readFileSync(full, "utf8");
    } catch {
      /* an unreadable artifact is reported as missing */
    }
  }

  if (owned && options.keepWorkspace !== true) fs.rmSync(workspace, { recursive: true, force: true });

  const result: NeoRunResult = {
    finalText,
    trace,
    promptTokens: [...model.promptTokenSamples],
    systemChars: (fixture.system ?? "").length,
    steps,
    rounds: roundsRun,
    callsAfterResume,
    resumedFrom,
    budgetExhausted,
    checks: [],
    files,
    clockIso: clock.iso(),
    durationMs: 0,
    citedSeedIds: extractCitations(finalText),
  };
  return { result, workspace, model };
}

/**
 * The script the loop's final verifier replays when a fixture declares none.
 *
 * The production loop gates every run behind `verifyFinal`, and a verifier turn
 * that returns no tool calls and no usable verdict JSON is scored `revise`
 * twice and the run is dropped as incomplete. A fixture therefore has to supply
 * a verdict. This default asks the loop's real read-only inspection tools to
 * open the fixture's captured artifact and emits a `pass` JSON only once that
 * inspection succeeded, so the gate still measures the artifact rather than
 * trusting the executor's claim.
 *
 * The verdict JSON is the shape `verifyFinal` itself requests, and the answer it
 * grounds is the body of the artifact that was just read back. The
 * `finalAnswerFromToolResult` hook exists because the production verifier only
 * promotes a verdict to the user-visible answer when its JSON carries a
 * non-empty `finalAnswer`; a fixture's plain-text script cannot emit that field.
 */
export function defaultVerifierScript(fixture: NeoFixture): NeoModelScript {
  const capture = fixture.capture?.[0];
  const pass: NeoScriptStep = {
    text: JSON.stringify({
      verdict: "pass",
      reason: "The completed artifact was read back and matches the fixture's declared result.",
      fixes: [],
    }),
    finalAnswerFromToolResult: "{EXCERPT}",
  };
  if (!capture) return { steps: [pass] };
  return {
    steps: [
      { calls: [{ tool: "file_read", args: { path: capture } }] },
      { ...pass, when: { afterCall: "file_read" } },
    ],
  };
}

/** Record a captured artifact's content, keyed by its workspace-relative path. */
function capture(
  workspace: string,
  args: Record<string, unknown>,
  targets: ReadonlySet<string>,
  files: Record<string, string>,
): void {
  const raw = args["path"];
  if (typeof raw !== "string" || !targets.has(raw)) return;
  const full = path.resolve(workspace, raw);
  try {
    if (fs.existsSync(full) && fs.statSync(full).isFile()) files[raw] = fs.readFileSync(full, "utf8");
  } catch {
    /* unreadable artifacts are reported as missing */
  }
}

/** Run a fixture and score it, keeping the workspace until scoring is done. */
export async function evaluateFixture(
  fixture: NeoFixture,
  options: Omit<RunFixtureOptions, "fixture"> = {},
): Promise<{ score: ReturnType<typeof scoreArtifacts>; workspace: string }> {
  const { result, workspace } = await runFixture({ ...options, fixture, keepWorkspace: true });
  const score = scoreArtifacts({
    fixture,
    run: result,
    store: new KnowledgeStore(fixture.seeds ?? []),
    workspace,
  } satisfies ScoreInputs);
  if (options.workspace === undefined) fs.rmSync(workspace, { recursive: true, force: true });
  return { score, workspace };
}

/** The tool names a fixture with no explicit `tools` would get. */
export function defaultToolNames(): string[] {
  return [...DEFAULT_TOOLS].sort();
}

/** The repo root, resolved from this module (used by the CLI and the baseline). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
