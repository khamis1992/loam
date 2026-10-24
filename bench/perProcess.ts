// Adapted from jcode (MIT) ref/bench_memory_cli.py (per-session tool spawn)
//
// J1 "BEFORE" launcher: one heavyweight process per coding session, which is
// exactly what Loam's current coding launcher does today. `code_session`
// (src/tools/codeSession.ts) shells out to a full `opencode run` process per
// task, and the linear agent loop (src/agent/loop.ts) does the same when it is
// spawned per task. This launcher reproduces that cost with the bench fake model
// so the J1 before/after comparison isolates the launcher shape rather than the
// model.
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, type RunOptions, type RunResult } from "../src/agent/loop.js";
import { buildSystemPrompt } from "../src/agent/prompt.js";
import { createTodoTools } from "../src/tools/todoTools.js";
import { createMultiEditTools } from "../src/tools/multiEdit.js";
import { fileTools } from "../src/tools/files.js";
import { shellTools } from "../src/tools/shell.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { OllamaClient } from "../src/ollama.js";
import type { Emit } from "../src/agent/events.js";
import { loadConfig, type Config } from "../src/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Where the bench repo's `calc.py` lives, as the child process's cwd. */
export const BENCH_FIXTURE = "calc.py";

const DEFAULT_MAX_STEPS = 8;

/**
 * Bench config: the real Loam defaults, with only the fields a bench session
 * reads overridden. Using `loadConfig()` keeps the object a genuine `Config`
 * (server/browser/memory/... all present) instead of a partial cast.
 */
export function benchConfig(workspace: string, modelUrl: string, model: string): Config {
  const cfg = loadConfig();
  cfg.model = model;
  cfg.fallbackModel = model;
  cfg.ollamaUrl = modelUrl;
  cfg.workspace = workspace;
  cfg.agent.maxSteps = DEFAULT_MAX_STEPS;
  cfg.agent.requestTimeoutMs = 120_000;
  cfg.policy.networkEnabled = true;
  cfg.policy.allowOutsideWorkspaceRead = true;
  cfg.policy.denyCommandPatterns = [];
  cfg.policy.allowCommandPatterns = [];
  cfg.policy.maxCommandSeconds = 30;
  cfg.policy.sandboxMode = "workspace-write";
  // A bench session must talk only to the fake model. Clear the cloud endpoint
  // (so `:cloud` ids never fall through) and disable the coding router, whose
  // failover chain would otherwise reach the host's real providers.
  cfg.cloudModel = undefined;
  cfg.coding = { enabled: false, chain: [], logEdits: false };
  return cfg;
}

/** Build the small, deterministic tool set the fixture needs. */
export function benchRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(fileTools);
  registry.registerAll(shellTools);
  registry.registerAll(createMultiEditTools());
  registry.registerAll(createTodoTools());
  return registry;
}

export const BENCH_PROMPT = "Fix the failing test in this repository and report what you changed.";

/**
 * The environment a bench session resolves its coding router against.
 *
 * `benchConfig()` already disables the router, but the router also reads
 * `LOAM_CODER_CHAIN`/`LOAM_CODER_ROUTING` straight from the environment, so this
 * strips those keys defensively: a bench session must never be re-routed to the
 * host's real failover chain. Returned as a plain object (the loop treats
 * `opts.env` as the whole environment it consults).
 */
export function benchEnvFromProcessEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  delete out.LOAM_CODER_CHAIN;
  delete out.MANUS_LOCAL_CODER_CHAIN;
  delete out.LOAM_CODER_ROUTING;
  return out;
}

/**
 * Fixture-specific observation: the fake model's script is `read calc.py` ->
 * `edit calc.py` -> `bash test_calc.py` -> final text, so success is the `edit`
 * turn landing and the final answer naming the fix. Nothing here reads the
 * filesystem; the verdict is the model's own report.
 */
export function isFixedReport(result: RunResult): boolean {
  const text = result.text.toLowerCase();
  return (
    text.includes("fixed") ||
    (text.includes("add") && (text.includes("subtr") || text.includes("a - b") || text.includes("a + b")))
  );
}

/**
 * Run one session against the fake model in the given workspace.
 * `emit` is intentionally not forwarded anywhere: the bench process has no UI.
 */
export async function runBenchSession(options: {
  workspace: string;
  modelUrl: string;
  model?: string;
  suppressFinal?: boolean;
  runEnv?: Record<string, string | undefined>;
}): Promise<RunResult> {
  const model = options.model ?? process.env.LOAM_BENCH_MODEL ?? "mock-coder";
  const cfg = benchConfig(options.workspace, options.modelUrl, model);
  const registry = benchRegistry();
  const ollama = new OllamaClient(options.modelUrl);
  const emit: Emit = (event) => {
    // Diagnostics only; never printed. The child process is a headless bench run.
    if (event.type === "error") process.stderr.write(`[bench] ${event.message}\n`);
  };
  const runOptions: RunOptions = {
    cfg,
    ollama,
    tools: registry,
    emit,
    env: options.runEnv ?? process.env,
    prompt: BENCH_PROMPT,
    suppressFinal: options.suppressFinal ?? true,
  };
  return runAgent(runOptions);
}

/**
 * Spawn `file ...args` as a child and run one bench session inside it.
 * Returns the pid so the caller (the bench orchestrator) can verify the
 * per-session process cost.
 */
export function spawnBenchSession(
  workspace: string,
  modelUrl: string,
  model?: string,
  suppressFinal?: boolean,
): ChildProcess {
  const args = [path.join(HERE, "perProcess.ts"), workspace, modelUrl, model ?? "", suppressFinal ? "1" : "0"];
  const child = spawn(process.execPath, ["--import", "tsx", ...args], {
    cwd: workspace,
    env: { ...process.env, LOAM_BENCH_SESSION: "per-process" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return child;
}

/** Entry point of the child process. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const t0 = Date.now();
  const phase = (name: string): void => {
    process.stdout.write(`[j1-probe] +${Date.now() - t0}ms ${name}\n`);
  };
  phase("entry");
  const [workspace, modelUrl, model = "", suppress = "0"] = argv;
  if (!workspace || !modelUrl) {
    process.stderr.write("usage: perProcess.ts <workspace> <modelUrl> [model] [suppressFinal]\n");
    return 2;
  }
  try {
    const result = await runBenchSession({
      workspace,
      modelUrl,
      ...(model ? { model } : {}),
      suppressFinal: suppress === "1",
      runEnv: benchEnvFromProcessEnv(),
    });
    phase(`session-done steps=${result.steps}`);
    process.stdout.write(`fixed=${isFixedReport(result) ? "1" : "0"} steps=${result.steps}\n`);
    phase("exit");
    return isFixedReport(result) ? 0 : 1;
  } catch (err) {
    process.stderr.write(`per-process bench session failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// Run only when invoked directly (node --import tsx bench/perProcess.ts ...).
const invokedDirectly = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  : false;
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`per-process bench session failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
