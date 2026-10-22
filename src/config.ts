import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

/** User data can live outside the app folder so updates never touch it.
 *  The packaged app sets these to %APPDATA%/manus-local (see electron/main.cjs). */
function fromEnv(name: string, fallback: string): string {
  const value = process.env[name.replace("MANUS_LOCAL_", "LOAM_")] ?? process.env[name];
  return value && value.trim() ? path.resolve(value) : fallback;
}

export const DATA_DIR = fromEnv("MANUS_LOCAL_DATA_DIR", path.join(ROOT, "data"));
export const SKILLS_DIR = fromEnv("MANUS_LOCAL_SKILLS_DIR", path.join(ROOT, "skills"));
export const EVALS_DIR = fromEnv("MANUS_LOCAL_EVALS_DIR", path.join(ROOT, "evals"));
export const UI_DIR = path.join(ROOT, "ui");
export const SCRIPTS_DIR = path.join(ROOT, "scripts");

export interface PolicyConfig {
  networkEnabled: boolean;
  allowOutsideWorkspaceRead: boolean;
  denyCommandPatterns: string[];
  allowCommandPatterns: string[];
  maxCommandSeconds: number;
}

export interface McpServerConfig {
  command?: string;
  transport?: "stdio" | "http";
  url?: string;
  headers?: Record<string, string>;
  args?: string[];
  env?: Record<string, string>;
}

export interface Config {
  model: string;
  fallbackModel: string;
  ollamaUrl: string;
  /** Optional OpenAI-compatible cloud provider (OpenRouter, vLLM, LM Studio, ...).
   *  Models whose name ends with ":cloud" are routed here; the suffix is stripped
   *  before the call. The user's own key stays in config.json — never in the repo. */
  cloudModel?: { baseUrl: string; apiKey?: string };
  server: { host: string; port: number };
  agent: { maxSteps: number; temperature: number; requestTimeoutMs: number };
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
  mcpServers: Record<string, McpServerConfig>;
  sessionLog: { enabled: boolean };
}

const DEFAULTS: Config = {
  model: "glm-5.3-flash:cloud",
  fallbackModel: "qwen2.5:14b",
  ollamaUrl: "http://127.0.0.1:11434",
  server: { host: "127.0.0.1", port: 3939 },
  agent: { maxSteps: 40, temperature: 0.2, requestTimeoutMs: 600000 },
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
  mcpServers: {},
  sessionLog: { enabled: true },
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

export function loadConfig(): Config {
  const p = process.env.LOAM_CONFIG ?? process.env.MANUS_LOCAL_CONFIG ?? path.join(ROOT, "config.json");
  let raw: unknown = {};
  try {
    if (fs.existsSync(p)) raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    console.warn(`[config] failed to parse ${p}: ${String(err)}`);
  }
  const cfg = merge(DEFAULTS, raw);
  if (process.env.LOAM_PORT || process.env.MANUS_LOCAL_PORT) cfg.server.port = Number(process.env.LOAM_PORT || process.env.MANUS_LOCAL_PORT);
  if (process.env.LOAM_HOST || process.env.MANUS_LOCAL_HOST) cfg.server.host = (process.env.LOAM_HOST || process.env.MANUS_LOCAL_HOST)!;
  const envRoot = process.env.LOAM_ROOT || process.env.MANUS_LOCAL_ROOT;
  if (envRoot) {
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
