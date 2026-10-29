import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EffortLevel } from "./llm/router.js";

import { ORCHESTRATION_DEFAULTS, clampOrchestration, type OrchestrationConfig } from "./orchestration/config.js";
import { resolvePruneConfig } from "./agent/prune/config.js";

function resolveRoot(): string {
  const candidates: string[] = [];
  if (process.env.LOAM_ROOT || process.env.MANUS_LOCAL_ROOT) candidates.push(path.resolve(process.env.LOAM_ROOT || process.env.MANUS_LOCAL_ROOT!));
  try {
    candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  } catch {
    /* import.meta unavailable (CJS bundle) */
  }
  candidates.push(process.cwd());
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "package.json"))) return c;
    } catch {
      /* ignore */
    }
  }
  return candidates[0] ?? process.cwd();
}

export const ROOT = resolveRoot();

/** Packaged builds keep ROOT inside resources/app.asar. Files that must exist on
 *  real disk (ffmpeg binary, three.js jsm addons, native modules) are placed in
 *  app.asar.unpacked by electron-builder (asarUnpack / extraResources). */
export const UNPACKED_ROOT = process.env.LOAM_UNPACKED_ROOT
  ? path.resolve(process.env.LOAM_UNPACKED_ROOT)
  : ROOT.replace(/\.asar$/i, ".asar.unpacked");

/** Resolve a bundled asset path, preferring the unpacked copy when it exists. */
export function rootAsset(...parts: string[]): string {
  if (UNPACKED_ROOT !== ROOT) {
    const unpacked = path.join(UNPACKED_ROOT, ...parts);
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return path.join(ROOT, ...parts);
}

/** User data can live outside the app folder so updates never touch it.
 *  The packaged app sets these to %APPDATA%/manus-local (see electron/main.cjs). */
function fromEnv(name: string, fallback: string): string {
  const value = process.env[name.replace("MANUS_LOCAL_", "LOAM_")] ?? process.env[name];
  return value && value.trim() ? path.resolve(value) : fallback;
}

export function dataDir(): string {
  return fromEnv("MANUS_LOCAL_DATA_DIR", path.join(ROOT, "data"));
}

/** Fold a config effort key to `fast` / `max`, or "" when it is not one of them.
 *  Kept local (see `loadConfig`) so config.ts never value-imports the router. */
function normalizeEffortName(value: string): EffortLevel | "" {
  const key = value.trim().toLowerCase();
  if (key === "fast" || key === "quick" || key === "low" || key === "lite") return "fast";
  if (key === "max" || key === "maximum" || key === "best") return "max";
  return "";
}

export const DATA_DIR = dataDir();
export const SKILLS_DIR = fromEnv("MANUS_LOCAL_SKILLS_DIR", path.join(ROOT, "skills"));
export const EVALS_DIR = fromEnv("MANUS_LOCAL_EVALS_DIR", path.join(ROOT, "evals"));
/** Vetted Loam UI Kit blocks (design-registry/blocks/<id>/manifest.json) used by ui_examples_search. */
export const DESIGN_REGISTRY_DIR = fromEnv("MANUS_LOCAL_DESIGN_REGISTRY_DIR", path.join(ROOT, "design-registry"));
export const UI_DIR = path.join(ROOT, "ui");
export const SCRIPTS_DIR = path.join(ROOT, "scripts");

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface PolicyConfig {
  networkEnabled: boolean;
  allowOutsideWorkspaceRead: boolean;
  denyCommandPatterns: string[];
  allowCommandPatterns: string[];
  maxCommandSeconds: number;
  /** Default sandbox mode for a task; overridden per session/task when set. */
  sandboxMode: SandboxMode;
}

export interface McpServerConfig {
  command?: string;
  transport?: "stdio" | "http";
  url?: string;
  headers?: Record<string, string>;
  args?: string[];
  env?: Record<string, string>;
  /** Optional tool-name allowlist: only listed tools from `tools/list` register
   *  (REA_INTO_LOAM §5.4). Enforced inside Loam — the server cannot widen it. */
  allowlist?: string[];
  /** "minimal" spawns the child with only a fixed OS-variable allowlist plus `env`
   *  (api-anything §6.3); default "inherit" keeps the full process environment. */
  envMode?: "inherit" | "minimal";
  /** Per-tool call timeouts in ms (api-anything §6.3); unlisted tools use defaultTimeoutMs. */
  toolTimeouts?: Record<string, number>;
  defaultTimeoutMs?: number;
  /** Opt-in OS sandbox for stdio servers (SANDBOX_RUNTIME appendix C4): spawn as
   *  `srt --settings … -- <command>` while the command sandbox mode is on. */
  sandbox?: boolean;
}

import type { CodeGraphConfig } from "./codegraph/config.js";
import type { ApiAnythingConfig } from "./tools/apiAnything/types.js";

export interface Config {
  model: string;
  fallbackModel: string;
  ollamaUrl: string;
  /** Optional OpenAI-compatible cloud provider (OpenRouter, vLLM, LM Studio, ...).
   *  Models whose name ends with ":cloud" are routed here; the suffix is stripped
   *  before the call. The user's own key stays in config.json — never in the repo.
   *  `images` opts `design_image_generate` into the same provider for image
   *  generation (BYOK): naming a model is the opt-in; baseUrl/apiKey fall back
   *  to the parent section. Env overrides: LOAM_IMAGE_MODEL / _BASE_URL / _API_KEY. */
  cloudModel?: {
    baseUrl: string;
    apiKey?: string;
    images?: { model?: string; baseUrl?: string; apiKey?: string };
  };
  server: { host: string; port: number };
  agent: { maxSteps: number; temperature: number; requestTimeoutMs: number };
  /** D19 session runtime: idle-to-sleep threshold and the per-session compute
   *  budget. Optional so test configs and older config.json files keep working;
   *  `loadConfig` fills it from DEFAULTS. */
  session?: {
    idleMinutes: number;
    stepLimit: number;
    tokenLimit: number;
    /** J7: idle minutes before derived caches are released (0 = off). */
    hibernationIdleMinutes: number;
  };
  /**
   * Neo N6 mission budget: the ceiling a `mission` run type is bounded by.
   * Unlike `session`, which gates an ordinary run, these limits lift the fixed
   * step cap. `steps: 0` (or omitted) means unbounded steps, so a mission runs
   * until the model answers, the user stops it, or another dimension runs out.
   */
  mission?: { steps: number; tokens: number; minutes: number; costUsd: number };
  /**
   * O6b startup recovery: `autoResume` resumes an interrupted task on boot
   * without human review, but only when its latest checkpoint is not in flight
   * (`inFlight === false`). Anything else keeps "Resume requires review".
   * Default off.
   */
  recovery?: { autoResume: boolean };
  workspace: string;
  policy: PolicyConfig;
  browser: { channel: string; headless: boolean; viewport: { width: number; height: number } };
  computerUse: { enabled: boolean; screenshotDir: string };
  memory: {
    enabled: boolean;
    model: string;
    file: string;
    autoStore: boolean;
    recallTop: number;
    minScore: number;
    /** Curate: hard cap on stored entries (0 = unlimited). */
    maxEntries: number;
    /** Merge a new memory into an existing one when cosine similarity >= this value. */
    dedupeThreshold: number;
  };
  screen: {
    enabled: boolean;
    fps: number;
    quality: number;
    maxWidth: number;
  };
  vision: { enabled: boolean; maxImagesPerStep: number; model?: string };
  selfImprove: {
    /** Run the background learning review after a task. */
    enabled: boolean;
    /** Run the reviewer every N completed tasks (1 = every task). */
    reviewEvery: number;
    /** Model for the review ("" = the main model). */
    model: string;
    /** Max steps for the review loop. */
    maxSteps: number;
    /** Stage skill/memory writes for human approval instead of applying them. */
    writeApproval: boolean;
  };
  /** Repo-local skills (`.loam/skills`, `.agents/skills`) + post-session auto-suggest. */
  skills: {
    /** After a successful session, propose a new repo-local SKILL.md for approval. */
    autoSuggest: boolean;
    /** Model for suggestions ("" = the main model). */
    suggestModel: string;
  };
  evaluation: {
    /** Run the configured suite on a fixed interval (continuous harness). */
    enabled: boolean;
    intervalMinutes: number;
    /** Suite id or path used by scheduled/UI runs. */
    suite: string;
    /** Ask the critic model to judge each case and record structured critiques. */
    critique: boolean;
    /** How many past eval runs to keep on disk. */
    keepRuns: number;
    /** Save full agent transcripts for eval cases (needed for fine-tuning export). */
    transcripts: boolean;
  };
  selfPlay: {
    /** Max cases a single self-play generation may produce. */
    maxCases: number;
  };
  /** Planner -> executor -> verifier orchestration with the reflection loop
   *  (plan -> act -> observe -> critique -> revise) replacing the linear agent loop. */
  orchestrator: {
    /** false = use the legacy single linear agent loop. */
    enabled: boolean;
    /** Model for planning ("" = the main model). */
    plannerModel: string;
    /** Model for the verifier/critic ("" = the main model). */
    verifierModel: string;
    /** Hard cap on the number of plan steps. */
    maxPlanSteps: number;
    /** Max agent steps inside one executor (worker) run. */
    maxStepsPerWorker: number;
    /** Extra executor attempts per step after a "revise" verdict. */
    maxRevisionsPerStep: number;
    /** How many times the plan may be rebuilt after a "fail" verdict. */
    maxReplans: number;
    /** Run the end-to-end verification pass after the plan completes. */
    /** Legacy configuration field; final verification is mandatory regardless. */
    verifyFinal: boolean;
  };
  /** ACP-style subagent delegation (delegate_task). */
  subagent: {
    /** Maximum delegation depth: a child may delegate up to this many levels. */
    maxDepth: number;
    /** Maximum number of concurrently running child subagents. */
    maxConcurrentChildren: number;
  };
  /** Codemode sandbox (opt-in, off by default): master switch plus per-run limits.
   *  Optional so a hand-written config.json need not repeat it. */
  codemode?: { enabled: boolean; timeoutMs: number; memoryBytes: number; maxToolCalls: number };
  /** H5 correction-learning injection (BUILD_SPEC .h2-ref/BUILD_SPEC.md §6.5/§10).
   *  Env overrides: LOAM_LESSONS_ENABLED, LOAM_LESSONS_MAX_CHARS, LOAM_LESSON_MIN_SCORE.
   *  Optional so test configs and older config.json files keep working;
   *  `loadConfig` fills it from DEFAULTS (and the env) via merge. */
  lessons?: {
    /** Append relevant learned lessons to the task's system prompt (default: on). */
    enabled: boolean;
    /** Hard cap on the injected lesson block in characters (default: 1200). */
    maxChars: number;
    /** Minimum relevance score for a lesson to be injected (default: 0.35). */
    minScore: number;
  };
  mcpServers: Record<string, McpServerConfig>;
  /** api-anything (Cap H): Loam-managed MCP server for public-site operations.
   *  Optional on the interface so test fixtures keep compiling (same pattern as
   *  `session`); `loadConfig` fills it from DEFAULTS. Disabled until the H4
   *  Windows acceptance checklist passes. */
  apiAnything?: ApiAnythingConfig;
  /** Code map (graphify engine). Absent = all defaults from src/codegraph/config.ts (disabled). */
  codeGraph?: Partial<CodeGraphConfig>;



  /** Orchestration Core (C1-C11). Optional on the interface so hand-written test fixtures keep compiling;
   * the loader always fills it (deep-merged over ORCHESTRATION_DEFAULTS, then clamped). */
  orchestration?: OrchestrationConfig;
  failover?: {
    providers: Array<{
      id: string;
      kind: "ollama" | "openai-compatible";
      baseUrl: string;
      model: string;
      apiKeyEnv: string;
      enabled: boolean;
    }>;
  },
  compression: {
    /** Enable/disable context compression (default: true). */
    enabled: boolean;
    /** Trigger compression when estimated tokens exceed this fraction of the model's context window (default: 0.50). */
    thresholdPercent: number;
    /** Number of leading messages to always protect from compression (default: 3 = system + first user + first assistant). */
    protectLead: number;
    /** Number of trailing messages to always protect from compression (default: 20). */
    protectTail: number;
    /** Target compression ratio for summarization step (default: 0.20, clamped to 0.10-0.80). */
    targetRatio: number;
    /** Tokens reserved for the answer and the next tool outputs. Compression also
     *  triggers once the transcript exceeds the window minus this buffer
     *  (default: 20000). The effective trigger is the earlier of the ratio
     *  threshold and this buffer. */
    bufferTokens: number;
    /** How many of the most recently read files to re-attach after compaction
     *  (default: 5; 0 disables re-attachment). */
    reattachFiles: number;
    /** Characters of each re-attached file snapshot to keep (default: 4000). */
    reattachFileChars: number;
    /**
     * Trigger a synchronous emergency hard-compact when the estimate exceeds this
     * fraction of the context window (default: 0.95, jcode parity). Above this point
     * the transcript is dropped/truncated immediately instead of waiting for the
     * summarizer, so the next API call is guaranteed to fit.
     */
    criticalThresholdPercent: number;
    /** Recent turns kept verbatim during emergency compaction (default: 10, jcode parity). */
    recentTurnsToKeep: number;
    /** Absolute minimum turns kept during emergency compaction (default: 2, jcode parity). */
    minTurnsToKeep: number;
    /** Max characters kept for a single tool result during emergency truncation (default: 4000, jcode parity). */
    emergencyToolResultMaxChars: number;
    /** Model to use for summarization ("" = main model). */
    model: string;
    /** Context window size per model prefix (longest-prefix match). Defaults cover common models. */
    contextWindow: Record<string, number>;
    /** Verbatim context pruning (always set by loadConfig; a missing file block means strategy "summary"). */
    prune?: import("./agent/prune/types.js").PruneConfig;
  };
  sessionLog: { enabled: boolean };
  /** Project wiki and handoff (src/wiki). Off unless the config file sets `wiki.enabled: true`. */
  wiki?: { enabled: boolean };
  /** App bridges (src/bridges). Every bridge is off unless listed `true` in `bridges.enabled`. */
  bridges?: { enabled: Record<string, boolean> };
  /** Neo run graph: record every agent event as a node of the task's run graph. */
  runGraph?: { enabled: boolean };
  /**
   * Neo N5: the per-step context selector ("memory manager"). Selects the
   * artefacts a step needs from the run's artefact store before the model is
   * called, so the transcript stays bounded without waiting for the
   * compressor's threshold. Partial configs are clamped onto the defaults.
   */
  contextSelector?: Partial<import("./agent/contextSelector.js").ContextSelectorConfig>;
  /** Coding-model routing (C17): prefer the strongest available coder for
   *  coding turns. The chain is a list of model ids (strongest first) matched
   *  against the failover providers. It never contains API keys — keys stay in
   *  the environment and are referenced by name through `apiKeyEnv`. */
  coding?: {
    /** Route coding turns through the coding chain (default: true). */
    enabled: boolean;
    /** Ordered coder preference list (strongest first). Empty = the failover order. */
    chain: string[];
    /** Append every edit tool call to the model-edit audit log (default: true). */
    logEdits: boolean;
  };
  /** Optional per-edit diagnostics overrides (LOAM.md may override these). */
  diagnostics?: import("./agent/diagnostics.js").DiagnosticSettings;
  /**
   * Neo N10 routing: the model map behind the composer's output-type and
   * effort selectors. Shares this key with C17/V14. Entries are model ids only,
   * never API keys. `perTool` names a tool; `effort` names a Fast/Max level.
   */
  routing?: import("./llm/router.js").RoutingConfig;
  /** Legal mode (Qatar). Absent = disabled; normalized by src/legal/config.ts. */
  legal?: Partial<import("./legal/config.js").LegalConfig>;
}

export const DEFAULTS: Config = {
  model: "glm-5.3-flash:cloud",
  fallbackModel: "qwen2.5:14b",
  ollamaUrl: "http://127.0.0.1:11434",
  server: { host: "127.0.0.1", port: 3939 },
  agent: { maxSteps: 40, temperature: 0.2, requestTimeoutMs: 600000 },
  // D19: sessions idle 30 minutes before their resources are reclaimed; the
  // per-session compute budget warns at 80% and stops at 100% (both raisable).
  session: { idleMinutes: 30, stepLimit: 40, tokenLimit: 500000, hibernationIdleMinutes: 30 },
  // Neo N6: a mission is unbounded in steps (0 = no cap) and bounded only by the
  // generous defaults below. Each dimension is raisable through the budget route.
  mission: { steps: 0, tokens: 5_000_000, minutes: 0, costUsd: 0 },
  recovery: { autoResume: false },
  workspace: path.join(ROOT, "workspace"),
  policy: {
    networkEnabled: true,
    allowOutsideWorkspaceRead: true,
    denyCommandPatterns: [
      "rm -rf /",
      "rm -rf c:\\",
      "format ",
      "shutdown",
      "diskpart",
      "vssadmin delete",
      "bcdedit",
      "cipher /w",
      "reg delete hklm",
      "net user ",
      "takeown /f c:\\",
      "remove-item -recurse -force c:\\",
    ],
    allowCommandPatterns: [],
    maxCommandSeconds: 180,
    sandboxMode: "workspace-write",
  },
  browser: { channel: "msedge", headless: false, viewport: { width: 1280, height: 800 } },
  computerUse: { enabled: true, screenshotDir: path.join(ROOT, "workspace", ".screenshots") },
  memory: {
    enabled: true,
    model: "nomic-embed-text:latest",
    file: path.join(DATA_DIR, "memory.json"),
    autoStore: false,
    recallTop: 3,
    minScore: 0.45,
    maxEntries: 2000,
    dedupeThreshold: 0.97,
  },
  screen: { enabled: true, fps: 1, quality: 60, maxWidth: 1280 },
  vision: { enabled: true, maxImagesPerStep: 2 },
  selfImprove: { enabled: true, reviewEvery: 1, model: "", maxSteps: 10, writeApproval: false },
  skills: { autoSuggest: true, suggestModel: "" },
  evaluation: { enabled: false, intervalMinutes: 360, suite: "core", critique: true, keepRuns: 30, transcripts: true },
  selfPlay: { maxCases: 5 },
  orchestrator: {
    enabled: true,
    plannerModel: "",
    verifierModel: "",
    maxPlanSteps: 8,
    maxStepsPerWorker: 24,
    maxRevisionsPerStep: 1,
    maxReplans: 1,
    verifyFinal: true,
  },
  subagent: { maxDepth: 2, maxConcurrentChildren: 4 },
  lessons: { enabled: true, maxChars: 1200, minScore: 0.35 },
  mcpServers: {},
  // Cap H §12.2: off until the H4 Windows acceptance checklist passes.
  apiAnything: {
    enabled: false,
    allowWrites: false,
    allowWriteLearning: false,
    browser: "edge",
    sites: "all",
    learnDomains: [],
    peopleOps: [
      "linkedin.getProfile",
      "linkedin.searchPeople",
      "instagram.getProfile",
      "instagram.getPosts",
      "x.getProfile",
      "x.getUser",
    ],
    peopleOpsTasks: [],
    peopleLimitPerTask: 20,
    rateLimit: { calls: 30, windowMs: 600_000 },
    outputBudgetChars: 15_000,
    timeouts: { listMs: 15_000, callMs: 180_000, loginMs: 900_000, learnMs: 300_000 },
  },
  // OD-7 (approved 2026-10-25 after W1-W12 passed — docs/codegraph/windows-validation.md):
  codeGraph: { enabled: true },



  orchestration: structuredClone(ORCHESTRATION_DEFAULTS),
  codemode: { enabled: false, timeoutMs: 300_000, memoryBytes: 64 * 1024 * 1024, maxToolCalls: 2_000 },
  failover: {
    providers: [
      { id: "ollama", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "glm-5.3:cloud", apiKeyEnv: "", enabled: true },
      // OpenCode Go: the official OpenAI-compatible endpoint is
      // https://opencode.ai/inference/go/openai/v1/chat/completions (OpenCode "Go" docs,
      // Endpoints table). The old `https://api.opencode.ai/v1` host does not serve this API
      // (GET /v1/models there returns 404).
      { id: "opencode-go", kind: "openai-compatible", baseUrl: "https://opencode.ai/inference/go/openai/v1", model: "opencode-go", apiKeyEnv: "OPENCODE_API_KEY", enabled: true },
      // freellmapi is a SELF-HOSTED OpenAI-compatible router, not a public host, and no
      // public endpoint is documented. The repo's own evidence is a local router:
      // docs/agents-state.json records `freellmapi/auto unreachable: localhost:31415 down`.
      // Disabled by default: the endpoint is unverified (C19). Enable it once the deployment is confirmed.
      { id: "freellmapi", kind: "openai-compatible", baseUrl: "http://127.0.0.1:31415/v1", model: "freellmapi/auto", apiKeyEnv: "FREELLM_API_KEY", enabled: false },
      // LongCat: official OpenAI-format endpoint
      // https://api.longcat.chat/openai/v1/chat/completions (LongCat API Platform Quick
      // Start), model LongCat-2.5-Preview.
      { id: "longcat", kind: "openai-compatible", baseUrl: "https://api.longcat.chat/openai/v1", model: "LongCat-2.5-Preview", apiKeyEnv: "LONGCAT_API_KEY", enabled: true },
      { id: "openrouter", kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/free", apiKeyEnv: "OPENROUTER_API_KEY", enabled: true },
      // ornith is a LOCAL Ollama model (docs/handoff/oc-local.json and
      // docs/handoff/watchdog.ps1 both define it under the ollama provider as
      // ornith-1.5:9b); it is not a remote api.ornith.ai service.
      { id: "ornith", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "ornith-1.5:9b", apiKeyEnv: "", enabled: true },
    ],
  },
  compression: {
    enabled: true,
    thresholdPercent: 0.5,
    protectLead: 3,
    protectTail: 20,
    targetRatio: 0.2,
    bufferTokens: 20000,
    reattachFiles: 5,
    reattachFileChars: 4000,
    criticalThresholdPercent: 0.95,
    recentTurnsToKeep: 10,
    minTurnsToKeep: 2,
    emergencyToolResultMaxChars: 4000,
    model: "",
    contextWindow: {
      "gpt-4": 8192,
      "gpt-4-32k": 32768,
      "gpt-4-turbo": 128000,
      "gpt-4o": 128000,
      "claude-3": 200000,
      "claude-3.5": 200000,
      "llama-3": 8192,
      "llama-3.1": 128000,
      "mistral": 32768,
      "mixtral": 32768,
      "qwen": 32768,
      "qwen2": 32768,
      "qwen2.5": 32768,
      "glm": 32768,
      "deepseek": 32768,
      "gemini": 1048576,
      "gemini-1.5": 1048576,
    },
  },
  sessionLog: { enabled: true },
  runGraph: { enabled: true },
  // Neo N5: on by default. `false` (or LOAM_CONTEXT_SELECTOR=0) keeps the
  // pre-N5 behaviour: the compressor alone decides what leaves the transcript.
  contextSelector: { enabled: true },
  coding: { enabled: true, chain: [], logEdits: true },
  // Neo N10: no map by default, so an unconfigured run keeps its current
  // behaviour (the coding chain for coding turns, the configured model else).
  routing: { perTool: {}, effort: {} },
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Cap H §6.2: clamp every api-anything field to its bounds; anything malformed
 *  falls back to the shipped default. outputBudgetChars caps at 15,500 so a
 *  result plus lifecycle-hook text stays under the registry's 16,000 cut. */
function normalizeApiAnything(raw: Record<string, unknown> | undefined): ApiAnythingConfig {
  // DEFAULTS carries the full shipped block (see below); the interface keeps the
  // field optional only for hand-written test fixtures.
  const d = DEFAULTS.apiAnything!;
  const r = raw ?? {};
  const bool = (v: unknown, def: boolean): boolean => (typeof v === "boolean" ? v : def);
  const int = (v: unknown, def: number, min: number, max: number): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : def;
  const strings = (v: unknown, def: string[], re: RegExp): string[] =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && re.test(x)))] : def;
  const SITE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
  const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/i;
  const SITE_OP = /^[a-z0-9][a-z0-9._-]{0,63}\.[A-Za-z0-9_-]{1,64}$/;
  const TASK = /^task_[a-zA-Z0-9_-]+$/;
  const rate = isObj(r.rateLimit) ? r.rateLimit : {};
  const t = isObj(r.timeouts) ? r.timeouts : {};
  return {
    enabled: bool(r.enabled, d.enabled),
    allowWrites: bool(r.allowWrites, d.allowWrites),
    allowWriteLearning: bool(r.allowWriteLearning, d.allowWriteLearning),
    browser: typeof r.browser === "string" && r.browser.trim() ? r.browser.trim().slice(0, 260) : d.browser,
    sites: r.sites === "all" || r.sites === undefined ? "all" : strings(r.sites, [], SITE),
    learnDomains: strings(r.learnDomains, d.learnDomains, DOMAIN).map((x) => x.toLowerCase()),
    peopleOps: strings(r.peopleOps, d.peopleOps, SITE_OP),
    peopleOpsTasks: strings(r.peopleOpsTasks, d.peopleOpsTasks, TASK),
    peopleLimitPerTask: int(r.peopleLimitPerTask, d.peopleLimitPerTask, 0, 200),
    rateLimit: {
      calls: int(rate.calls, d.rateLimit.calls, 1, 1_000),
      windowMs: int(rate.windowMs, d.rateLimit.windowMs, 1_000, 86_400_000),
    },
    outputBudgetChars: int(r.outputBudgetChars, d.outputBudgetChars, 2_000, 15_500),
    timeouts: {
      listMs: int(t.listMs, d.timeouts.listMs, 1_000, 120_000),
      callMs: int(t.callMs, d.timeouts.callMs, 5_000, 900_000),
      loginMs: int(t.loginMs, d.timeouts.loginMs, 60_000, 3_600_000),
      learnMs: int(t.learnMs, d.timeouts.learnMs, 30_000, 1_800_000),
    },
  };
}

/** Keep only explicit `true` flags keyed by a plain bridge id; anything else stays off. */
function readBridgeFlags(v: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!isObj(v)) return out;
  for (const [id, on] of Object.entries(v)) if (on === true && /^[a-z][a-z0-9_-]{0,39}$/.test(id)) out[id] = true;
  return out;
}

export function normalizeHibernationMinutes(value: unknown): number {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0) return 0;
  return Math.floor(minutes);
}

function merge<T>(base: T, over: unknown): T {
  if (!isObj(over)) return base;
  if (!isObj(base)) return over as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isObj(b) && isObj(v) ? merge(b, v) : v;
  }
  return out as T;
}

/**
 * O6b: parse an opt-in flag. Only `1` and `true` (as a JSON boolean or an
 * untrimmed string) enable it; every other value — including `"0"`, `1` as a
 * number, `"yes"`, `null` and a missing key — keeps it off.
 *
 * Shared by the `config.json` value and the environment variables, so the two
 * paths cannot drift apart. `config.json` is user-editable, and a stray `"0"`
 * there is truthy, so without this an interrupted task would resume without
 * review on the next boot.
 */
function parseOptInFlag(value: unknown): boolean {
  return value === true || value === "1" || value === "true";
}

export function loadConfig(): Config {
  const p = process.env.LOAM_CONFIG ?? process.env.MANUS_LOCAL_CONFIG ?? path.join(ROOT, "config.json");
  let raw: unknown = {};
  try {
    if (fs.existsSync(p)) raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    console.warn(`[config] failed to parse ${p}: ${String(err)}`);
  }
  const cfg = merge(DEFAULTS, raw);
  // Orchestration Core §4.0.1: deep-merge each section over the shipped defaults, then clamp.
  cfg.orchestration = clampOrchestration({
    ...ORCHESTRATION_DEFAULTS,
    ...(cfg.orchestration ?? {}),
    tracing: { ...ORCHESTRATION_DEFAULTS.tracing, ...(cfg.orchestration?.tracing ?? {}) },
    durability: { ...ORCHESTRATION_DEFAULTS.durability, ...(cfg.orchestration?.durability ?? {}) },
    interrupts: { ...ORCHESTRATION_DEFAULTS.interrupts, ...(cfg.orchestration?.interrupts ?? {}) },
    contracts: { ...ORCHESTRATION_DEFAULTS.contracts, ...(cfg.orchestration?.contracts ?? {}) },
    ledger: { ...ORCHESTRATION_DEFAULTS.ledger, ...(cfg.orchestration?.ledger ?? {}) },
    selection: { ...ORCHESTRATION_DEFAULTS.selection, ...(cfg.orchestration?.selection ?? {}) },
    acp: { ...ORCHESTRATION_DEFAULTS.acp, ...(cfg.orchestration?.acp ?? {}) },
    returnDirect: { ...ORCHESTRATION_DEFAULTS.returnDirect, ...(cfg.orchestration?.returnDirect ?? {}) },
    workflows: { ...ORCHESTRATION_DEFAULTS.workflows, ...(cfg.orchestration?.workflows ?? {}) },
    evals: { ...ORCHESTRATION_DEFAULTS.evals, ...(cfg.orchestration?.evals ?? {}) },
    memoryRanking: { ...ORCHESTRATION_DEFAULTS.memoryRanking, ...(cfg.orchestration?.memoryRanking ?? {}) },
    swarm: { ...ORCHESTRATION_DEFAULTS.swarm, ...(cfg.orchestration?.swarm ?? {}) },
  } as OrchestrationConfig);
  // Verbatim pruning: resolved from the file's own block (not from DEFAULTS), so a
  // stale config without one keeps the summary-only behaviour.
  cfg.compression.prune = resolvePruneConfig(
    isObj(raw) && isObj(raw.compression) ? raw.compression.prune : undefined,
  );
  cfg.wiki = { enabled: isObj(raw) && isObj(raw.wiki) && raw.wiki.enabled === true };
  cfg.bridges = { enabled: readBridgeFlags(isObj(raw) && isObj(raw.bridges) ? raw.bridges.enabled : undefined) };
  // Cap H §6.2: sanitize the whole block from the file (merge already layered DEFAULTS,
  // but the normalizer revalidates every field against its bounds). loadConfig always
  // leaves a full object here even though the interface keeps the field optional.
  cfg.apiAnything = normalizeApiAnything(isObj(raw) && isObj(raw.apiAnything) ? raw.apiAnything : undefined);
  cfg.coding = { enabled: cfg.coding?.enabled ?? true, chain: cfg.coding?.chain ?? [], logEdits: cfg.coding?.logEdits ?? true };
  // J7: normalize the hibernation setting. A negative or non-numeric value means
  // "off" (0), so a stale config.json can never arm a bogus timer. `merge` can
  // leave `session` undefined for a config that omits it, so fill it here.
  cfg.session = { ...DEFAULTS.session!, ...(cfg.session ?? {}) };
  cfg.session.hibernationIdleMinutes = normalizeHibernationMinutes(cfg.session.hibernationIdleMinutes);
  if (process.env.LOAM_HIBERNATION_IDLE_MINUTES) {
    cfg.session.hibernationIdleMinutes = normalizeHibernationMinutes(Number(process.env.LOAM_HIBERNATION_IDLE_MINUTES));
  }
  // O6b: normalized inline so every caller sees a definite value (a test config
  // built as a partial literal must not have to spell this out).
  cfg.recovery = { autoResume: parseOptInFlag(cfg.recovery?.autoResume) };
  const coderChainEnv = process.env.LOAM_CODER_CHAIN ?? process.env.MANUS_LOCAL_CODER_CHAIN;
  if (coderChainEnv && coderChainEnv.trim()) {
    cfg.coding.chain = coderChainEnv
      .split(/[,\s]+/)
      .map((m) => m.trim())
      .filter((m) => m.length > 0);
  }
  if (process.env.LOAM_CODER_ROUTING === "0" || process.env.LOAM_CODER_ROUTING === "false") cfg.coding.enabled = false;
  // H5 lesson-injection env overrides (BUILD_SPEC §10); invalid values keep the defaults.
  const lessonsCfg = cfg.lessons ?? { enabled: true, maxChars: 1200, minScore: 0.35 };
  const lessonsEnabledEnv = process.env.LOAM_LESSONS_ENABLED;
  if (lessonsEnabledEnv === "0" || lessonsEnabledEnv === "false") lessonsCfg.enabled = false;
  else if (lessonsEnabledEnv === "1" || lessonsEnabledEnv === "true") lessonsCfg.enabled = true;
  const lessonsMaxCharsEnv = Number(process.env.LOAM_LESSONS_MAX_CHARS);
  if (Number.isFinite(lessonsMaxCharsEnv) && lessonsMaxCharsEnv > 0) lessonsCfg.maxChars = Math.floor(lessonsMaxCharsEnv);
  const lessonMinScoreEnv = Number(process.env.LOAM_LESSON_MIN_SCORE);
  if (Number.isFinite(lessonMinScoreEnv) && lessonMinScoreEnv >= 0 && lessonMinScoreEnv <= 1) lessonsCfg.minScore = lessonMinScoreEnv;
  cfg.lessons = lessonsCfg;
  // Neo N10: normalize the routing map. Unknown effort levels are dropped and
  // model ids are trimmed, so a stale config can never select a bogus entry.
  const perTool: Record<string, string> = {};
  for (const [tool, model] of Object.entries(cfg.routing?.perTool ?? {})) {
    if (typeof model === "string" && model.trim()) perTool[tool] = model.trim().slice(0, 120);
  }
  const routingEffort: { fast?: string; max?: string } = {};
  for (const [level, model] of Object.entries(cfg.routing?.effort ?? {})) {
    // Normalized inline: importing the router here would create a load-time
    // cycle (`router -> codingRouter -> config`), and `failover.ts` reads the
    // module-level `DATA_DIR` from config at import time, so the cycle surfaces
    // as "Cannot access 'DATA_DIR' before initialization" in unrelated tests.
    const key = normalizeEffortName(level);
    if (key && typeof model === "string" && model.trim()) routingEffort[key] = model.trim().slice(0, 120);
  }
  cfg.routing = { perTool, effort: routingEffort };
  if (process.env.LOAM_PORT || process.env.MANUS_LOCAL_PORT) cfg.server.port = Number(process.env.LOAM_PORT || process.env.MANUS_LOCAL_PORT);
  // O6b: auto-resume is opt-in. An explicit `0`/`false` turns the flag off even
  // when `config.json` asked for it; anything unrecognised leaves the file's
  // (already fail-closed) value alone, so a typo in the launch script cannot open
  // the gate.
  const autoResumeEnv = process.env.LOAM_AUTO_RESUME ?? process.env.MANUS_LOCAL_AUTO_RESUME;
  if (autoResumeEnv === "0" || autoResumeEnv === "false") cfg.recovery.autoResume = false;
  else if (parseOptInFlag(autoResumeEnv)) cfg.recovery.autoResume = true;
  if (process.env.LOAM_HOST || process.env.MANUS_LOCAL_HOST) cfg.server.host = (process.env.LOAM_HOST || process.env.MANUS_LOCAL_HOST)!;
  const envRoot = process.env.LOAM_ROOT || process.env.MANUS_LOCAL_ROOT;
  // Packaged builds pass ROOT = resources/app.asar (read-only archive); the
  // desktop shell already points config.workspace at the user-data folder.
  if (envRoot && !/\.asar$/i.test(envRoot)) {
    const root = path.resolve(envRoot);
    // LOAM_ROOT is the install/user-data root: keep workspace and screenshots under it
    // rather than letting config.json silently override them back into the source tree.
    cfg.workspace = path.resolve(root, "workspace");
    cfg.computerUse.screenshotDir = path.resolve(root, "workspace", ".screenshots");
  }
  cfg.workspace = path.resolve(cfg.workspace);
  cfg.computerUse.screenshotDir = path.resolve(cfg.computerUse.screenshotDir);
  cfg.memory.file = path.resolve(cfg.memory.file);
  fs.mkdirSync(cfg.workspace, { recursive: true });
  fs.mkdirSync(cfg.computerUse.screenshotDir, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(EVALS_DIR, { recursive: true });
  return cfg;
}
