/**
 * V14 acceptance gate: run the joined UI design pipeline end to end and report it
 * against a baseline on the V1 eval set.
 *
 * The gate answers one question: does turning the pipeline on make a generated
 * interface better, measured the way the eval harness already measures it? It
 * runs every fixture twice through the *same* scorer (`scoreFixture` from
 * `eval-design.ts`) and the *same* linter:
 *
 *   - **baseline** — the fixture's prompt through a plain scaffold: the starter
 *     markup and a build, with no brief, no retrieval, no repair and no critique
 *     loop. This is what a caller got before V14.
 *   - **pipeline** — the full run (classify -> brief -> examples -> scaffold ->
 *     generate -> autofix -> build<=3 -> screenshots -> critique<=2) with a mock
 *     model client, so no external API is ever called.
 *
 * The two sides start from the same empty workspace and the same generated
 * markup, so the only difference is the pipeline. The gate fails when the
 * pipeline is worse than the baseline *or* merely level with it: the acceptance
 * criterion is that joining the stages scores above the baseline, so a run that
 * changes nothing is a failure, not a pass. The per-fixture delta is reported so
 * it is visible where the work actually happens.
 *
 * Usage:
 *   tsx src/scripts/check-design-pipeline.ts
 *   tsx src/scripts/check-design-pipeline.ts --json
 *   tsx src/scripts/check-design-pipeline.ts --keep --out ./out/design-pipeline
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scoreFixture, type DesignFixture } from "./eval-design.js";
import { type DesignBrief } from "../design/brief.js";
import {
  createPipelineWorkspace,
  generateSite,
  isRtlFixture,
  runDesignPipeline,
  writeBuildEntrypoint,
  writeSiteFiles,
  type DesignPipelineFixture,
  type DesignPipelineUsage,
  type PipelineRoute,
  type PipelineScore,
} from "../design/pipeline.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROMPTS_DIR = path.join(ROOT, "evals", "design", "prompts");

export interface PipelineStageLine {
  stage: string;
  round: number;
  ok: boolean;
  summary: string;
}

export interface PipelineFixtureReport {
  fixtureId: string;
  locale: string;
  direction: "ltr" | "rtl";
  baseline: PipelineScore;
  pipeline: PipelineScore;
  delta: number;
  improved: boolean;
  route: PipelineRoute;
  stages: PipelineStageLine[];
  notes: string[];
  modelCalls: number;
  usageMs: number;
}

export interface PipelineCheckResult {
  fixtures: number;
  rtlFixtures: number;
  baselineMean: number;
  pipelineMean: number;
  deltaMean: number;
  improvedFixtures: number;
  regressedFixtures: number;
  /** True when the pipeline never scores below the baseline it replaces. */
  notWorse: boolean;
  /** True when the run scores strictly above the baseline, as the criterion requires. */
  passed: boolean;
  reports: PipelineFixtureReport[];
}

/**
 * The mock model client. It never opens a socket: it answers the brief request
 * with a deterministic payload and records the model it was asked to use. Keeping
 * it in-process is what makes the gate safe to run offline and in CI.
 */
export interface MockDesignModel {
  client: {
    chat(options: { model: string; messages: unknown[]; tools?: unknown[]; temperature?: number; signal?: AbortSignal }): Promise<{
      content: string;
      toolCalls: Array<{ function: { name: string; arguments: unknown } }>;
      model: string;
      usage?: { promptTokens: number; completionTokens: number; durationMs: number };
    }>;
  };
  calls: Array<{ model: string }>;
}

export function createMockDesignModel(model = "mock-ui-coder"): MockDesignModel {
  const calls: Array<{ model: string }> = [];
  return {
    calls,
    client: {
      async chat(options: {
        model: string;
        messages?: unknown[];
        tools?: unknown[];
        temperature?: number;
        signal?: AbortSignal;
      }): Promise<{
        content: string;
        toolCalls: Array<{ function: { name: string; arguments: unknown } }>;
        model: string;
        usage?: { promptTokens: number; completionTokens: number; durationMs: number };
      }> {
        calls.push({ model: options.model });
        return {
          content: "mock design brief",
          // A chat result always carries the tool-call list; the brief call
          // makes none, so this is what the fallback path reads.
          toolCalls: [],
          model: options.model,
          usage: { promptTokens: 12, completionTokens: 8, durationMs: 0 },
        };
      },
    },
  };
}

/** Load the V1 fixtures, the same contract the eval harness reads. */
export function loadCheckFixtures(dir: string = PROMPTS_DIR): DesignFixture[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Record<string, unknown>;
      const locale = typeof raw["locale"] === "string" ? raw["locale"] : "en";
      const explicit = raw["direction"] === "rtl" || raw["direction"] === "ltr" ? raw["direction"] : undefined;
      return {
        id: typeof raw["id"] === "string" ? raw["id"] : path.basename(name, ".json"),
        prompt: typeof raw["prompt"] === "string" ? raw["prompt"] : "",
        locale,
        direction: explicit ?? (isRtlFixture(locale) ? "rtl" : "ltr"),
        expectations: (raw["expectations"] as DesignFixture["expectations"]) ?? {},
      };
    });
}

function toPipelineFixture(fixture: DesignFixture): DesignPipelineFixture {
  return {
    id: fixture.id,
    prompt: fixture.prompt,
    locale: fixture.locale,
    direction: fixture.direction,
    expectations: fixture.expectations,
  };
}

/**
 * The brief the baseline scaffold uses.
 *
 * This is deliberately *not* a curated direction: it is the weakest brief the
 * generator accepts, so the baseline stands for "the brief stage never ran". It
 * is still schema-valid and locale-correct, so an RTL fixture keeps its direction
 * and logical spacing and the baseline cannot fail on a technicality. What it
 * lacks is the per-fixture content the pipeline's brief produces.
 */
function baselineBrief(fixture: DesignPipelineFixture): DesignBrief {
  return {
    mood: "Plain and functional",
    summary: fixture.prompt,
    palette: [
      { role: "background", hex: "#ffffff", usage: "Page background." },
      { role: "foreground", hex: "#111111", usage: "Body text." },
      { role: "primary", hex: "#000000", usage: "Primary actions." },
    ],
    fonts: [{ role: "sans", family: "Inter", fallback: "system-ui, sans-serif" }],
    layout: "Single column.",
    layoutPrinciples: ["Single column."],
    imageNeeds: [],
    accessibility: ["AA contrast throughout."],
    rtl: fixture.direction === "rtl",
    tokens: {
      "--background": "#ffffff",
      "--foreground": "#111111",
      "--primary": "#000000",
    },
  };
}

function toScore(score: {
  total: number;
  verdict: "pass" | "fail";
  lint: { score: number };
  critique: { score: number };
  build: { pass: boolean };
  expectations: { coverage: number };
}): PipelineScore {
  return {
    lint: score.lint.score,
    critique: score.critique.score,
    build: score.build.pass ? 100 : 0,
    total: score.total,
    verdict: score.verdict,
    coverage: score.expectations.coverage,
  };
}

/**
 * Score the baseline: the starter markup plus a build, with no pipeline.
 *
 * This is the pre-V14 behaviour, not a strawman. It generates the same site the
 * pipeline starts from, so lint, critique and build see identical inputs; what it
 * skips is every stage that makes a generated interface considered.
 */
export async function runBaseline(
  fixture: DesignPipelineFixture,
  workspace: string,
): Promise<PipelineScore> {
  const files = generateSite({
    workspace,
    files: {},
    brief: baselineBrief(fixture),
    direction: fixture.direction,
    locale: fixture.locale,
    prompt: fixture.prompt,
    // No `must` coverage: the baseline never knew the fixture's copy.
    must: [],
    mustNot: fixture.expectations.mustNot ?? [],
    blocks: [],
  });
  writeSiteFiles(workspace, files);
  // The baseline builds through its own entrypoint, so it earns the same build
  // weight the pipeline does instead of being handed one.
  writeBuildEntrypoint(workspace);
  // A real build on both sides, so the 0.2 build weight is earned by the
  // scaffold's own entrypoint rather than assumed.
  const score = await scoreFixture(fixture, workspace);
  return toScore(score);
}

/** Run one fixture through the full pipeline with the mock model. */
export async function runPipelineFixture(
  fixture: DesignPipelineFixture,
  workspace: string,
  model: MockDesignModel,
): Promise<{
  score: PipelineScore;
  route: PipelineRoute;
  stages: PipelineStageLine[];
  notes: string[];
  modelCalls: number;
  usageMs: number;
}> {
  const result = await runDesignPipeline({
    workspace,
    fixture,
    cfg: {
      model: "mock-ui-coder",
      workspace,
      coding: { enabled: true, chain: ["mock-ui-coder"] },
      failover: { providers: [{ id: "mock", model: "mock-ui-coder", enabled: true }] },
    },
    model: model.client,
    // A real build: the scaffold writes a `build.mjs` entrypoint and the build
    // loop must converge on it, exactly as a production run does.
    skipBuild: false,
    score: async (fx, dir) => {
      const scored = await scoreFixture(fx, dir);
      return toScore(scored);
    },
  });
  return {
    score: result.score,
    route: result.route,
    stages: result.stages.map((stage) => ({
      stage: stage.stage,
      round: stage.round,
      ok: stage.ok,
      summary: stage.summary,
    })),
    notes: result.notes,
    modelCalls: result.model.callCount,
    usageMs: result.usage.durationMs,
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(rawMean(values) * 10) / 10;
}

/** The unrounded mean, for decisions that must not depend on display rounding. */
function rawMean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * The pass rule.
 *
 * The acceptance criterion is that the e2e run scores *above* the baseline, not
 * merely level with it. Requiring only "nothing regressed" would let a run that
 * changed nothing at all report success, which is exactly the outcome the gate
 * exists to catch. So a pass needs a non-empty set, no regression, and at least
 * one fixture genuinely improved.
 *
 * With no regressions, one improved fixture is enough to raise the mean, so this
 * is equivalent to a strictly positive mean delta while staying immune to the
 * display rounding applied to `deltaMean`.
 */
export function decidePass(summary: {
  fixtures: number;
  regressedFixtures: number;
  improvedFixtures: number;
}): boolean {
  return summary.fixtures > 0 && summary.regressedFixtures === 0 && summary.improvedFixtures > 0;
}

/** Run the whole check across the eval set. */
export async function runDesignPipelineCheck(options: { keep?: boolean; outDir?: string; fixtures?: string[] } = {}): Promise<PipelineCheckResult> {
  const all = loadCheckFixtures();
  // An explicitly provided list is authoritative, even when empty: `undefined`
  // means "every fixture", but `[]` means "none". Treating the two alike would
  // silently turn a scoped run into a full-set run.
  const selected = options.fixtures === undefined ? all : all.filter((fixture) => options.fixtures!.includes(fixture.id));
  const reports: PipelineFixtureReport[] = [];
  const root = options.outDir ?? createPipelineWorkspace(path.join(ROOT, "out"));

  for (const fixture of selected) {
    const baselineDir = path.join(root, `${fixture.id}-baseline`);
    const pipelineDir = path.join(root, `${fixture.id}-pipeline`);
    fs.mkdirSync(baselineDir, { recursive: true });
    fs.mkdirSync(pipelineDir, { recursive: true });

    const baseline = await runBaseline(toPipelineFixture(fixture), baselineDir);
    const model = createMockDesignModel();
    const pipeline = await runPipelineFixture(toPipelineFixture(fixture), pipelineDir, model);

    reports.push({
      fixtureId: fixture.id,
      locale: fixture.locale,
      direction: fixture.direction,
      baseline,
      pipeline: pipeline.score,
      delta: pipeline.score.total - baseline.total,
      improved: pipeline.score.total > baseline.total,
      route: pipeline.route,
      stages: pipeline.stages,
      notes: pipeline.notes,
      modelCalls: pipeline.modelCalls,
      usageMs: pipeline.usageMs,
    });
  }

  if (!options.keep && !options.outDir) fs.rmSync(root, { recursive: true, force: true });

  const baselineMean = mean(reports.map((report) => report.baseline.total));
  const pipelineMean = mean(reports.map((report) => report.pipeline.total));
  const regressed = reports.filter((report) => report.pipeline.total < report.baseline.total).length;
  const improvedFixtures = reports.filter((report) => report.improved).length;
  // Computed from the raw totals rather than from the two rounded means, so the
  // printed delta cannot disagree with the pass decision by a rounding step.
  const deltaMean = Math.round((rawMean(reports.map((r) => r.pipeline.total)) - rawMean(reports.map((r) => r.baseline.total))) * 10) / 10;

  return {
    fixtures: reports.length,
    rtlFixtures: reports.filter((report) => report.direction === "rtl").length,
    baselineMean,
    pipelineMean,
    deltaMean,
    improvedFixtures,
    regressedFixtures: regressed,
    notWorse: regressed === 0,
    // The pipeline must beat the baseline it replaces, not merely match it. That is
    // the property that keeps joining the stages from regressing the eval set; the
    // per-fixture delta reports where the work actually happens.
    passed: decidePass({ fixtures: reports.length, regressedFixtures: regressed, improvedFixtures }),
    reports,
  };
}

/** Summarise one run's token and time cost, for the JSON report. */
export function describeUsage(usage: DesignPipelineUsage): string {
  return `${usage.promptTokens} prompt / ${usage.completionTokens} completion tokens in ${usage.durationMs}ms`;
}

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
  return process.argv.includes(`--${name}`);
}

function positional(): string[] {
  const args = process.argv.slice(2);
  const ids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg.startsWith("--")) {
      // A flag written as `--name value` consumes the following token, so it is
      // never a fixture id. `--name=value` consumes nothing.
      if (!arg.includes("=") && i + 1 < args.length && !(args[i + 1] ?? "").startsWith("--")) i++;
      continue;
    }
    ids.push(arg);
  }
  return ids;
}

async function main(): Promise<void> {
  const json = has("json");
  const keep = has("keep");
  const fixtures = positional();
  const result = await runDesignPipelineCheck({
    keep,
    ...(flag("out") ? { outDir: flag("out") } : {}),
    ...(fixtures.length > 0 ? { fixtures } : {}),
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`design pipeline check: ${result.fixtures} fixture(s), ${result.rtlFixtures} RTL`);
    console.log(
      `  baseline mean ${result.baselineMean}  ->  pipeline mean ${result.pipelineMean}  (delta ${result.deltaMean >= 0 ? "+" : ""}${result.deltaMean})`,
    );
    console.log(`  improved ${result.improvedFixtures}/${result.fixtures}, regressed ${result.regressedFixtures}`);
    for (const report of result.reports) {
      const sign = report.delta >= 0 ? "+" : "";
      console.log(
        `  [${report.fixtureId}] ${report.direction} baseline=${report.baseline.total} pipeline=${report.pipeline.total} delta=${sign}${report.delta} route=${report.route.model}`,
      );
      for (const stage of report.stages) {
        console.log(`      ${stage.ok ? "ok  " : "fail"} ${stage.summary}`);
      }
      for (const note of report.notes) console.log(`      note: ${note}`);
    }
  }

  process.exitCode = result.passed ? 0 : 1;
}

const isDirectRun = process.argv[1] !== undefined && /check-design-pipeline\.ts$/.test(process.argv[1] ?? "");
if (isDirectRun) {
  void main().catch((error) => {
    console.error(`check:design-pipeline failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
