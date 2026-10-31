/**
 * lazy-senior P4 A/B harness: Loam's own before/after numbers. The same
 * fixture task runs on the local model with the coding discipline `off` and
 * `full`, and this script reports the deltas between those two arms — nothing
 * else. No external benchmark's figures are used or displayed anywhere.
 *
 * Run:  node --import tsx bench/lazy-senior/run-ab.ts
 * Env:  LOAM_AB_MODEL   (default qwen36-uncensored-hauhau:latest)
 *       LOAM_AB_OLLAMA  (default http://127.0.0.1:11434)
 *       LOAM_AB_RUNS    (default 3 — runs per arm)
 *       LOAM_AB_KEEP=1  (keep the last staging copy for inspection)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadConfig, type Config } from "../../src/config.js";
import { OllamaClient } from "../../src/ollama.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { fileTools } from "../../src/tools/files.js";
import { shellTools } from "../../src/tools/shell.js";
import { createCodeSessionTools } from "../../src/tools/codeSession.js";
import { runAgent } from "../../src/agent/loop.js";
import { clearSessionLevel, setSessionLevel } from "../../src/agent/lazySenior.js";
import { computeTaskMetrics, metricsRows, type TaskMetrics } from "../../src/server/taskMetrics.js";
import type { StepRecord } from "../../src/server/db.js";
import type { Emit } from "../../src/agent/events.js";

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(benchDir, "..", "..");

const MODEL = process.env.LOAM_AB_MODEL ?? "qwen36-uncensored-hauhau:latest";
const OLLAMA_URL = process.env.LOAM_AB_OLLAMA ?? "http://127.0.0.1:11434";
const RUNS = Math.max(1, Number(process.env.LOAM_AB_RUNS ?? "3"));
const TIMEOUT_MS = 10 * 60 * 1000;

const TASKS = [
  {
    id: "reuse-form",
    fixture: "reuse-form",
    prompt: "Add an email field to the signup form.",
  },
];

const ARMS = ["off", "full"] as const;
type Arm = (typeof ARMS)[number];

interface RunRecord {
  arm: Arm;
  run: number;
  reusePass: boolean;
  addedNewComponent: boolean;
  error?: string;
  metrics: TaskMetrics;
}

function buildRegistry(): ToolRegistry {
  const base = new ToolRegistry();
  const tools: Tool[] = [...fileTools, ...shellTools, ...createCodeSessionTools()];
  for (const tool of tools) base.register(tool);
  // Build-mode allowlist keeps the write pair and a build marker, so the
  // lazy-senior injection gate (isBuildToolset) sees a real build toolset.
  return base.forMode("build");
}

function fixtureFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...fixtureFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

function stageFixture(fixture: string): { workspace: string; staging: string; manifest: string[] } {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "lazy-ab-"));
  const workspace = path.join(staging, "proj");
  fs.cpSync(path.join(benchDir, "fixtures", fixture), workspace, { recursive: true });
  return { workspace, staging, manifest: fixtureFiles(workspace) };
}

/** T1 reuse criteria, checked on the final workspace: the form imports the
 *  existing helpers and no new component file was created. */
function evaluateReuse(workspace: string, manifest: string[]): { reusePass: boolean; addedNewComponent: boolean } {
  const formPath = path.join(workspace, "src", "SignupForm.tsx");
  let form = "";
  try {
    form = fs.readFileSync(formPath, "utf8");
  } catch {
    return { reusePass: false, addedNewComponent: true };
  }
  const after = fixtureFiles(workspace);
  const addedNewComponent = after.some((file) => !manifest.includes(file) && /components\//.test(file));
  const reusePass = /validateEmail/.test(form) && /components[/\\]Input/.test(form) && !addedNewComponent;
  return { reusePass, addedNewComponent };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function summarize(records: RunRecord[]) {
  const ok = records.filter((r) => !r.error);
  return {
    runs: records.length,
    completed: ok.length,
    errors: records.filter((r) => r.error).length,
    reusePass: ok.filter((r) => r.reusePass).length,
    medianTokensOut: median(ok.map((r) => r.metrics.tokensOut ?? 0)),
    medianTokensIn: median(ok.map((r) => r.metrics.tokensIn ?? 0)),
    medianMs: median(ok.map((r) => r.metrics.elapsedMs ?? 0)),
    medianTurns: median(ok.map((r) => r.metrics.turns ?? 0)),
    medianFilesTouched: median(ok.map((r) => r.metrics.filesTouched)),
    medianLinesAdded: median(ok.map((r) => r.metrics.linesAdded)),
  };
}

function pct(offValue: number | null, fullValue: number | null): string {
  if (offValue === null || fullValue === null || offValue === 0) return "n/a";
  const delta = ((offValue - fullValue) / offValue) * 100;
  return `${delta >= 0 ? "−" : "+"}${Math.abs(delta).toFixed(0)}%`;
}

async function main(): Promise<void> {
  const cfg: Config = { ...loadConfig(), model: MODEL, ollamaUrl: OLLAMA_URL };
  const ollama = new OllamaClient(OLLAMA_URL, cfg.cloudModel);
  const registry = buildRegistry();
  const records: RunRecord[] = [];

  for (const task of TASKS) {
    for (const arm of ARMS) {
      for (let run = 0; run < RUNS; run++) {
        const sessionId = `ab-${task.id}-${arm}-${run}`;
        const { workspace, staging, manifest } = stageFixture(task.fixture);
        const steps: StepRecord[] = [];
        const emit: Emit = (event) => {
          steps.push({ at: new Date().toISOString(), type: event.type, data: event });
        };
        setSessionLevel(sessionId, arm);
        process.stdout.write(`[${task.id}] arm=${arm} run=${run + 1}/${RUNS} …\n`);
        let error: string | undefined;
        try {
          const result = await runAgent({
            cfg: { ...cfg, workspace } as Config,
            ollama,
            tools: registry,
            emit,
            prompt: task.prompt,
            maxSteps: 14,
            taskId: sessionId,
            sessionId,
            signal: AbortSignal.timeout(TIMEOUT_MS),
            // Pin every routed coding call to the local model: the harness
            // rewrites whichever provider the chain picked onto the local
            // Ollama endpoint with the pinned model id.
            createProviderClient: () => ({
              chat: (opts) => ollama.chat({ ...opts, model: MODEL }),
            }),
          });
          steps.push({
            at: new Date().toISOString(),
            type: "usage",
            data: { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens, model: result.model },
          });
          steps.push({ at: new Date().toISOString(), type: "done", data: { text: result.text, steps: result.steps, model: result.model } });
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        clearSessionLevel(sessionId);
        const metrics = computeTaskMetrics(steps);
        const { reusePass, addedNewComponent } = evaluateReuse(workspace, manifest);
        records.push({ arm, run, reusePass, addedNewComponent, error, metrics });
        if (error) process.stdout.write(`  error: ${error}\n`);
        else process.stdout.write(`  ${metricsRows(metrics).map((r) => `${r.label}=${r.value}`).join("  ")}  reuse=${reusePass ? "pass" : "FAIL"}\n`);
        if (process.env.LOAM_AB_KEEP === "1" && run === RUNS - 1 && arm === ARMS[ARMS.length - 1]) {
          process.stdout.write(`  kept staging: ${staging}\n`);
        } else {
          fs.rmSync(staging, { recursive: true, force: true });
        }
      }
    }
  }

  const byArm = Object.fromEntries(ARMS.map((arm) => [arm, summarize(records.filter((r) => r.arm === arm))]));
  const report = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    ollamaUrl: OLLAMA_URL,
    runsPerArm: RUNS,
    tasks: TASKS.map((t) => t.id),
    note: "Loam's own A/B numbers for the lazy-senior discipline. Fixture tasks; small N; local model. Not comparable to any external benchmark.",
    byArm,
    records,
  };
  const resultsDir = path.join(benchDir, "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const outFile = path.join(resultsDir, `ab-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");

  const off = byArm.off!;
  const full = byArm.full!;
  process.stdout.write(
    [
      "",
      "## lazy-senior A/B — Loam's own numbers",
      "",
      `Model: ${MODEL} · runs per arm: ${RUNS} · arm off vs arm full`,
      "",
      "| Metric | off | full | delta (full vs off) |",
      "|---|---|---|---|",
      `| Output tokens (median) | ${off.medianTokensOut ?? "n/a"} | ${full.medianTokensOut ?? "n/a"} | ${pct(off.medianTokensOut, full.medianTokensOut)} |`,
      `| Wall-clock s (median) | ${off.medianMs !== null ? Math.round(off.medianMs / 1000) : "n/a"} | ${full.medianMs !== null ? Math.round(full.medianMs / 1000) : "n/a"} | ${pct(off.medianMs, full.medianMs)} |`,
      `| Turns (median) | ${off.medianTurns ?? "n/a"} | ${full.medianTurns ?? "n/a"} | ${pct(off.medianTurns, full.medianTurns)} |`,
      `| Files touched (median) | ${off.medianFilesTouched ?? "n/a"} | ${full.medianFilesTouched ?? "n/a"} | ${pct(off.medianFilesTouched, full.medianFilesTouched)} |`,
      `| Lines added (median) | ${off.medianLinesAdded ?? "n/a"} | ${full.medianLinesAdded ?? "n/a"} | ${pct(off.medianLinesAdded, full.medianLinesAdded)} |`,
      `| Reuse pass | ${off.reusePass}/${off.completed} | ${full.reusePass}/${full.completed} | — |`,
      "",
      `Results: ${outFile}`,
      "",
    ].join("\n"),
  );
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
