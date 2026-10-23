/**
 * Coding eval harness (task C18) — the measuring stick for the Claude-Code
 * parity work.
 *
 * Runs the 20 small fixture repos under `evals/coding/tasks/` headless against
 * the Loam coding agent and prints pass@1. Grading is the fixture's hidden test
 * command exit code, so the suite is deterministic and offline.
 *
 * Modes:
 *   --mode=agent       run the real coding agent (default; this is the benchmark)
 *   --mode=self-check  apply each fixture's reference solution; every task must pass
 *   --mode=baseline    run untouched trees; every hidden test must FAIL (fixtures bite)
 *
 * Usage:
 *   npm run eval:coding
 *   npm run eval:coding -- --only=task-001,task-005
 *   npm run eval:coding -- --mode=self-check --json
 *   npm run eval:coding -- --record-baseline
 *
 * The C11 coding-prompt eval lives at `npm run eval:coding-prompt`.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { buildRuntime } from "../setup/runtime.js";
import { codingEvalsDir } from "../eval/coding/tasks.js";
import { defaultResultsDir, runCodingEval } from "../eval/coding/runner.js";
import type { CodingRunReport, EvalMode } from "../eval/coding/types.js";

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i] ?? "";
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === `--${name}`) {
      const next = process.argv[i + 1];
      return next && !next.startsWith("--") ? next : "true";
    }
  }
  return undefined;
}

function has(name: string): boolean {
  return flag(name) !== undefined;
}

const MODES: readonly EvalMode[] = ["agent", "self-check", "baseline"];

function parseMode(raw: string | undefined): EvalMode {
  const mode = (raw ?? "agent") as EvalMode;
  if (!MODES.includes(mode)) throw new Error(`--mode must be one of ${MODES.join(", ")} (got ${raw})`);
  return mode;
}

function baselinePath(): string {
  return path.join(codingEvalsDir(), "baseline.json");
}

function baselineMarkdownPath(): string {
  return path.join(codingEvalsDir(), "BASELINE.md");
}

/** Render the human-readable baseline note committed with the fixtures. */
function baselineMarkdown(report: CodingRunReport): string {
  const lines: string[] = [
    "# Coding eval baseline",
    "",
    `Recorded ${report.finishedAt} in \`${report.mode}\` mode.`,
    "",
    `- pass@1: ${(report.passAt1 * 100).toFixed(1)}%`,
    `- passed: ${report.passed}/${report.total}`,
    `- failed: ${report.failed}`,
    `- errors: ${report.errors}`,
    `- skipped: ${report.skipped}`,
    `- duration: ${report.durationMs}ms`,
    "",
    "## Per task",
    "",
    "| task | category | status | steps | duration |",
    "| --- | --- | --- | --- | --- |",
    ...report.results.map(
      (r) => `| ${r.id} | ${r.category} | ${r.status} | ${r.steps ?? "-"} | ${r.durationMs}ms |`,
    ),
    "",
    "## Notes",
    "",
    "`self-check` applies each fixture's reference solution, so pass@1=100% means every",
    "fixture and its hidden test agree. `baseline` runs the untouched tree and inverts the",
    "verdict, so pass@1=100% there means every hidden test actually fails without a fix.",
    "The `agent` mode is the real benchmark; it is only meaningful when a model is reachable.",
    "",
  ];
  return lines.join("\n");
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Write the recorded baseline: the committed evidence for C18. */
function recordBaseline(report: CodingRunReport, outPath: string): void {
  const payload = {
    recordedAt: report.finishedAt,
    mode: report.mode,
    model: report.model,
    passAt1: report.passAt1,
    total: report.total,
    passed: report.passed,
    failed: report.failed,
    errors: report.errors,
    durationMs: report.durationMs,
    tasks: report.results.map((r) => ({
      id: r.id,
      category: r.category,
      status: r.status,
      steps: r.steps ?? null,
      durationMs: r.durationMs,
    })),
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.writeFileSync(baselineMarkdownPath(), baselineMarkdown(report), "utf8");
}

async function main(): Promise<void> {
  // `--self-check` and `--baseline` are accepted as bare flags for convenience;
  // `--mode=<...>` remains the explicit form.
  const flagMode = flag("mode");
  const bareMode = has("self-check") ? "self-check" : has("baseline") ? "baseline" : undefined;
  const mode = parseMode(bareMode ?? flagMode);
  const only = (flag("only") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const json = has("json");
  const record = has("record-baseline");
  const min = Number(flag("min") ?? "0");
  const cfg = loadConfig();
  const workDir = flag("workdir") ?? defaultResultsDir();

  console.log(`coding-eval: mode=${mode} model=${cfg.model} workdir=${workDir}`);

  const runtime = mode === "agent" ? await buildRuntime(cfg, { mcp: false }) : null;
  let report: CodingRunReport;
  try {
    report = await runCodingEval({
      mode,
      model: cfg.model,
      ...(only.length > 0 ? { only } : {}),
      workDir,
      ...(runtime ? { agent: { cfg, ollama: runtime.ollama as never, registry: runtime.registry } } : {}),
      onTask: (r) => {
        const mark = r.status === "pass" ? "PASS" : r.status.toUpperCase();
        console.log(`  ${mark} ${r.id} (${r.category}) ${r.durationMs}ms${r.error ? ` — ${r.error}` : ""}`);
      },
    });
  } finally {
    await runtime?.dispose();
  }

  console.log(
    `pass@1=${pct(report.passAt1)} passed=${report.passed}/${report.total} failed=${report.failed} errors=${report.errors} skipped=${report.skipped} in ${report.durationMs}ms`,
  );

  if (record) {
    const out = baselinePath();
    recordBaseline(report, out);
    console.log(`baseline recorded: ${out}`);
    console.log(`baseline note: ${baselineMarkdownPath()}`);
  }

  const reportFile = path.join(workDir, `report-${mode}.json`);
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`report: ${reportFile}`);

  if (json) console.log(JSON.stringify(report, null, 2));

  const threshold = Number.isFinite(min) ? min : 0;
  process.exitCode = report.passAt1 >= threshold && report.errors === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`eval:coding failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
