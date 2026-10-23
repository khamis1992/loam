/**
 * N20 long-horizon eval gate runner.
 *
 * Runs the ten fixtures in `evals/neo/fixtures.ts` through the production agent
 * loop on the scripted offline model, scores each case on completion, citation,
 * flatness and recovery, and records a version-pinned baseline so a later merge
 * (N4 recipe engine, N5 branches, N6 missions) cannot regress the gate.
 *
 * The runner is fully offline and deterministic: no network, no real model, no
 * writes outside the per-case temporary workspace. It is the "CI-like local
 * mode" the N20 contract asks for.
 *
 * Usage:
 *   tsx src/scripts/eval-neo.ts            # run the suite, print a summary
 *   tsx src/scripts/eval-neo.ts --json     # machine-readable result
 *   tsx src/scripts/eval-neo.ts --record   # write/refresh the baseline
 *   tsx src/scripts/eval-neo.ts --id <id>  # run one fixture
 *   tsx src/scripts/eval-neo.ts --list     # list fixture ids
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateFixture } from "../neoEval/harness.js";
import {
  NEO_HARNESS_VERSION,
  type NeoBaseline,
  type NeoCaseScore,
  type NeoSuiteResult,
} from "../neoEval/types.js";
import { suiteResult } from "../neoEval/scoring.js";
import { NEO_FIXTURES, fixtureById } from "../../evals/neo/fixtures.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASELINE_PATH = path.join(ROOT, "evals", "neo", "baseline.json");

/** Read the recorded baseline, if one exists. */
export function readBaseline(file: string = BASELINE_PATH): NeoBaseline | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8")) as NeoBaseline;
  } catch {
    return undefined;
  }
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

/**
 * How far a case may drop before the gate fails.
 *
 * The baseline is a recorded score, not a floor a case can slide under. A small
 * tolerance absorbs scoring arithmetic that legitimately changes with the
 * harness version; anything beyond it is a regression a later merge has to
 * justify rather than inherit.
 */
const BASELINE_TOLERANCE = 1;

function caseTotal(cases: readonly NeoCaseScore[], id: string): number | undefined {
  return cases.find((c) => c.id === id)?.total;
}

/**
 * Compare a run against the recorded baseline.
 *
 * A missing case, a case that regressed past the tolerance, or a suite that
 * stopped clearing its own pass bar all fail. A baseline recorded under a
 * different harness version is ignored rather than compared: the scorer changed,
 * so its numbers are not comparable.
 */
export function compareBaseline(
  result: NeoSuiteResult,
  baseline: NeoBaseline | undefined,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!baseline) return { ok: true, reasons };
  if (baseline.version !== result.version) {
    return { ok: true, reasons: [`baseline version ${baseline.version} != ${result.version}; not compared`] };
  }
  if (result.passed !== result.cases.length) {
    reasons.push(`suite did not clear its pass bar (${result.passed}/${result.cases.length} passed)`);
  }
  for (const recorded of baseline.cases) {
    const current = caseTotal(result.cases, recorded.id);
    if (current === undefined) {
      reasons.push(`baseline case ${recorded.id} is missing from this run`);
      continue;
    }
    if (recorded.verdict === "pass" && current < result.passBar) {
      reasons.push(`${recorded.id} regressed below the bar (${current} < ${result.passBar})`);
    }
    if (recorded.total - current > BASELINE_TOLERANCE) {
      reasons.push(`${recorded.id} regressed ${round1(recorded.total - current)} point(s) below its baseline`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Persist a baseline so a regression is observable rather than silent. */
export function writeBaseline(result: NeoSuiteResult, file: string = BASELINE_PATH): NeoBaseline {
  const baseline: NeoBaseline = {
    version: NEO_HARNESS_VERSION,
    passBar: result.passBar,
    total: result.total,
    passed: result.passed,
    failed: result.failed,
    cases: result.cases.map((c) => ({
      id: c.id,
      total: c.total,
      verdict: c.verdict,
      completion: c.completion,
      citation: c.citation,
      flatness: c.flatness,
      recovery: c.recovery,
      recurring: c.recurring,
      steps: c.steps,
      dimensions: c.dimensions.map((d) => ({ name: d.name, score: d.score, detail: d.detail })),
    })),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  return baseline;
}

async function main(): Promise<void> {
  const json = has("json");
  const list = has("list");
  const record = has("record");
  const id = flag("id");

  if (list) {
    console.log(JSON.stringify(NEO_FIXTURES.map((f) => ({ id: f.id, dimension: f.dimension })), null, 2));
    return;
  }

  const selected = id ? [fixtureById(id)] : NEO_FIXTURES;
  if (id && selected[0] === undefined) {
    console.error(`unknown fixture: ${id}`);
    process.exitCode = 1;
    return;
  }
  const fixtures = selected.filter((f) => f !== undefined);
  if (fixtures.length === 0) {
    console.error("no fixtures selected");
    process.exitCode = 1;
    return;
  }

  const scores = [];
  for (const fixture of fixtures) {
    const { score } = await evaluateFixture(fixture);
    scores.push(score);
    if (!json) {
      const dims = score.dimensions.map((d) => `${d.name}=${d.score}`).join(" ");
      console.log(`[${score.id}] total=${score.total} ${score.verdict.toUpperCase()} steps=${score.steps} ${dims}`);
    }
  }

  const result = suiteResult(scores);
  let baseline: NeoBaseline | undefined;
  let baselineCheck: { ok: boolean; reasons: string[] } | undefined;
  if (record) {
    baseline = writeBaseline(result);
    console.log(`baseline written to ${path.relative(ROOT, BASELINE_PATH)}`);
  } else {
    // A single-fixture run has no suite baseline to compare against, so the
    // comparison only happens on a full-suite run.
    if (!id) {
      baseline = readBaseline();
      baselineCheck = compareBaseline(result, baseline);
    }
  }

  if (json) {
    console.log(JSON.stringify({ ...result, baselineCheck }, null, 2));
  } else {
    console.log(
      `\nneo eval ${result.version}: total=${result.total} passed=${result.passed}/${result.cases.length} bar=${result.passBar} verdict=${result.verdict.toUpperCase()}` +
        (baseline ? ` (baseline ${baseline.total})` : " (no baseline recorded)"),
    );
    if (baselineCheck && baselineCheck.reasons.length > 0) {
      console.error(`baseline regression: ${baselineCheck.reasons.join("; ")}`);
    } else if (baselineCheck) {
      console.log("baseline: no regression");
    }
  }

  process.exitCode = result.verdict === "pass" && (baselineCheck?.ok ?? true) ? 0 : 1;
}

void main().catch((error) => {
  console.error(`eval:neo failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
