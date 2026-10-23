/**
 * Scoring for the long-horizon gate (N20).
 *
 * Four dimensions, fixed weights, deterministic arithmetic:
 *
 * - **completion** — did the run actually finish the work the fixture asked for?
 *   Driven by the fixture's own verifier-style assertions, plus a penalty when
 *   the loop ran out of steps or produced no answer at all.
 * - **citation** — did every claim the answer makes trace back to a seeded
 *   knowledge document, with no invented source?
 * - **flatness** — did token spend stay flat across a long run instead of
 *   growing with the transcript?
 * - **recovery** — did the run survive injected tool failures and still deliver?
 *
 * A dimension a fixture does not exercise is `null` and is left out of the
 * weighted total: a short fixture is not punished for a behaviour it never had a
 * chance to show. Every scorer is pure, so a recorded baseline is comparable
 * run to run.
 */
import fs from "node:fs";
import path from "node:path";

import { NEO_PASS_BAR, NEO_WEIGHTS } from "./types.js";
import type {
  NeoCaseArtifacts,
  NeoCaseScore,
  NeoCheckResult,
  NeoDimensionScore,
  NeoFixture,
  NeoAssertSpec,
  NeoRunResult,
  NeoSuiteResult,
} from "./types.js";
import { NEO_HARNESS_VERSION } from "./types.js";
import { KnowledgeStore, extractCitations } from "./knowledge.js";

function clamp100(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * Evaluate a fixture's declared assertions against the run.
 *
 * These are the same shape as the C18 suite's verifier specs (file_exists,
 * file_matches, ...), so a fixture reads like the suites it sits next to.
 */
export function runAssertions(fixture: NeoFixture, artifacts: NeoCaseArtifacts): NeoCheckResult[] {
  const results: NeoCheckResult[] = [];
  for (const spec of fixture.asserts ?? []) {
    const label = describeAssert(spec);
    let ok = false;
    let detail = "not evaluated";
    switch (spec.kind) {
      case "file_exists": {
        ok = Boolean(spec.path && artifacts.files[spec.path] !== undefined);
        detail = ok ? `${spec.path} exists` : `${spec.path ?? "(no path)"} missing`;
        break;
      }
      case "resumed": {
        ok = artifacts.resumedFrom;
        detail = ok
          ? "the run was interrupted and resumed from its checkpoint"
          : "the run was never interrupted, so the restart path was not exercised";
        break;
      }
      case "file_matches": {
        const text = spec.path ? artifacts.files[spec.path] : undefined;
        if (text === undefined) detail = `${spec.path ?? "(no path)"} not captured`;
        else {
          try {
            ok = new RegExp(spec.value ?? "").test(text);
            detail = ok ? `${spec.path} matches /${spec.value ?? ""}/` : `${spec.path} does not match /${spec.value ?? ""}/`;
          } catch (error) {
            detail = `invalid regex /${spec.value ?? ""}/: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        break;
      }
      case "answer_matches": {
        const needle = (spec.value ?? "").toLowerCase();
        ok = needle.length > 0 && artifacts.finalText.toLowerCase().includes(needle);
        detail = ok ? `answer contains "${spec.value}"` : `answer does not contain "${spec.value}"`;
        break;
      }
      case "trace_used": {
        ok = artifacts.trace.some((t) => t.name === spec.tool);
        detail = ok ? `${spec.tool} was used` : `${spec.tool} was never called`;
        break;
      }
      case "trace_not_used": {
        ok = !artifacts.trace.some((t) => t.name === spec.tool);
        detail = ok ? `${spec.tool} was correctly not used` : `${spec.tool} was used despite the fixture`;
        break;
      }
      case "count_min": {
        const count = artifacts.trace.filter((t) => t.name === spec.tool).length;
        ok = count >= (spec.count ?? 0);
        detail = `${spec.tool} called ${count} time(s) (minimum ${spec.count ?? 0})`;
        break;
      }
    }
    results.push({ kind: spec.kind, label, ok, detail });
  }
  return results;
}

function describeAssert(spec: NonNullable<NeoFixture["asserts"]>[number]): string {
  switch (spec.kind) {
    case "file_exists":
      return `file_exists:${spec.path}`;
    case "resumed":
      return "resumed:checkpoint";
    case "file_matches":
      return `file_matches:${spec.path}`;
    case "answer_matches":
      return `answer_matches:${spec.value}`;
    case "trace_used":
      return `trace_used:${spec.tool}`;
    case "trace_not_used":
      return `trace_not_used:${spec.tool}`;
    case "count_min":
      return `count_min:${spec.tool}:${spec.count}`;
  }
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/**
 * Completion is the share of the fixture's assertions that held, with a hard
 * penalty when the loop ran out of steps or produced no answer. A run that
 * exhausted its budget cannot be credited for assertions it never reached.
 */
export function scoreCompletion(fixture: NeoFixture, artifacts: NeoCaseArtifacts): NeoDimensionScore {
  const checked = artifacts.checks;
  if (checked.length === 0) {
    return {
      name: "completion",
      score: 0,
      detail: "no assertions declared, so nothing was verified",
    };
  }
  const passed = checked.filter((c) => c.ok).length;
  let score = clamp100((passed / checked.length) * 100);
  const penalties: string[] = [];
  if (artifacts.budgetExhausted) {
    score = clamp100(score * 0.5);
    penalties.push("step budget exhausted (half credit)");
  }
  if (!artifacts.finalText.trim()) {
    score = 0;
    penalties.push("no final answer");
  }
  return {
    name: "completion",
    score: round2(score),
    detail: [`${passed}/${checked.length} assertions passed`, ...penalties, `score ${round2(score)}`].join("; "),
  };
}

// ---------------------------------------------------------------------------
// Citation
// ---------------------------------------------------------------------------

/**
 * Citation accuracy is precision times recall over the seeded sources:
 *
 * - every citation the answer makes must name a real seed (precision), and
 * - every seed the fixture expects must actually be cited (recall).
 *
 * A run that cites nothing scores 0: an answer without a source is an
 * assertion, not a grounded one.
 */
export function scoreCitation(
  artifacts: NeoCaseArtifacts,
  store: KnowledgeStore,
  expectedSeedIds: readonly string[] = [],
): NeoDimensionScore {
  const cited = artifacts.citedSeedIds.length > 0 ? artifacts.citedSeedIds : extractCitations(artifacts.finalText);
  const expected = expectedSeedIds;

  if (cited.length === 0) {
    return {
      name: "citation",
      score: 0,
      detail: "no [seed:ID] citation in the answer",
    };
  }

  const known = cited.filter((id) => store.get(id) !== undefined);
  const precision = known.length / cited.length;
  const recall = expected.length === 0 ? 1 : known.filter((id) => expected.includes(id)).length / expected.length;
  const score = clamp100(precision * recall * 100);
  const unknown = cited.filter((id) => !known.includes(id));
  const hitExpected = known.filter((id) => expected.includes(id));

  return {
    name: "citation",
    score: round2(score),
    detail: [
      `${known.length}/${cited.length} citations resolve to a seed`,
      expected.length > 0 ? `${hitExpected.length}/${expected.length} expected seeds cited` : "no expected seeds declared",
      ...(unknown.length > 0 ? [`unknown source(s): ${unknown.join(", ")}`] : []),
      `score ${round2(score)}`,
    ].join("; "),
  };
}

// ---------------------------------------------------------------------------
// Flatness
// ---------------------------------------------------------------------------

export interface FlatnessOptions {
  /** Growth ratio above which the run is judged non-flat. */
  maxGrowthRatio?: number;
  /**
   * Growth at or below this ratio counts as flat.
   *
   * Token estimates are noisy: a run that wobbles by a few percent because the
   * mock rounds its own character count is not growing with its transcript. The
   * band keeps the dimension measuring growth rather than rounding noise.
   */
  flatToleranceRatio?: number;
  /** Minimum samples needed before a ratio can be judged. */
  minSamples?: number;
}

/**
 * Token flatness: a long run should not keep paying for its own history.
 *
 * The measurement is the ratio of the last step's prompt tokens to the first
 * step's. A well-behaved loop writes its findings to disk and reads them back
 * instead of re-reading a growing transcript, so the ratio stays near 1. A loop
 * that grows roughly linearly is caught here.
 */
export function scoreFlatness(artifacts: NeoCaseArtifacts, opts: FlatnessOptions = {}): NeoDimensionScore {
  const maxRatio = opts.maxGrowthRatio ?? 3;
  const tolerance = opts.flatToleranceRatio ?? 1.1;
  const minSamples = opts.minSamples ?? 4;
  const samples = artifacts.promptTokensPerStep.filter((n) => n > 0);

  if (samples.length < minSamples) {
    return {
      name: "flatness",
      score: 0,
      detail: `only ${samples.length} token sample(s) (need ${minSamples}) — run too short to judge`,
    };
  }

  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const peak = Math.max(...samples);
  const ratio = first === 0 ? Infinity : last / first;
  const peakRatio = first === 0 ? Infinity : peak / first;

  const scoreFor = (value: number): number => {
    if (value <= tolerance) return 100;
    return clamp100(((maxRatio - Math.min(value, maxRatio)) / (maxRatio - tolerance)) * 100);
  };
  const ratioScore = scoreFor(ratio);
  const peakScore = scoreFor(peakRatio);
  const score = round2(clamp100(ratioScore * 0.6 + peakScore * 0.4));

  return {
    name: "flatness",
    score: round2(score),
    detail: [
      `first step ${first} prompt tokens, last ${last}, peak ${peak}`,
      `growth ${round2(ratio)}x (limit ${maxRatio}x)`,
      `flat up to ${tolerance}x`,
      `score ${round2(score)}`,
    ].join("; "),
  };
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/**
 * Recovery: the run is credited for failures it survived and penalised for
 * failures it let stop the work.
 *
 * Two signals, both directly observable in the trace:
 *
 * - a failure that was followed by a successful retry of the *same* tool (the
 *   agent worked around it), and
 * - a run that ended with a delivered answer despite at least one failure.
 *
 * A failure with no later success and no delivered answer is an unrecovered
 * failure and drives the score to zero.
 */
export function scoreRecovery(artifacts: NeoCaseArtifacts): NeoDimensionScore {
  const failures = artifacts.trace.filter((t) => !t.ok && t.name !== "run");
  if (failures.length === 0) {
    return {
      name: "recovery",
      score: 100,
      detail: "no tool failures injected; recovery not exercised",
    };
  }

  const retried = new Set<string>();
  for (let i = 0; i < artifacts.trace.length; i++) {
    const item = artifacts.trace[i]!;
    if (item.ok) continue;
    if (artifacts.trace.slice(i + 1).some((t) => t.name === item.name && t.ok)) retried.add(item.name);
  }

  const recoveredNames = new Set<string>();
  for (const failure of failures) {
    if (retried.has(failure.name)) recoveredNames.add(failure.name);
    else if (artifacts.finalText.trim()) recoveredNames.add(failure.name);
  }
  const score = clamp100((recoveredNames.size / new Set(failures.map((f) => f.name)).size) * 100);
  const unrecovered = [...new Set(failures.map((f) => f.name))].filter((n) => !recoveredNames.has(n));

  return {
    name: "recovery",
    score: round2(score),
    detail: [
      `${failures.length} failure(s) injected (${[...new Set(failures.map((f) => f.name))].join(", ") || "none"})`,
      `${recoveredNames.size} recovered`,
      ...(unrecovered.length > 0 ? [`unrecovered: ${unrecovered.join(", ")}`] : []),
      `score ${round2(score)}`,
    ].join("; "),
  };
}

// ---------------------------------------------------------------------------
// Recurring
// ---------------------------------------------------------------------------

/**
 * Recurring work: did every declared round actually run, and did the tracker
 * keep its own state across the virtual clock instead of restarting from zero?
 *
 * Two signals, both observable:
 *
 * - the share of declared rounds that actually ran, and
 * - the appends the trace shows against the round count the fixture declares.
 *
 * The second signal is read from the trace rather than from the fixture's own
 * `count_min` assertion: the assertion is the *expectation*, the trace is what
 * the run actually did. A run that replays its rounds but rewrites the same
 * file each time is caught here.
 */
export function scoreRecurring(
  fixture: NeoFixture,
  artifacts: NeoCaseArtifacts,
): NeoDimensionScore {
  const declared = fixture.rounds?.length ?? 0;
  if (declared === 0) {
    return { name: "recurring", score: 0, detail: "no rounds declared" };
  }
  const ran = artifacts.rounds;
  const artifactScore = clamp100((ran / declared) * 100);

  const declaredWrites = fixture.asserts
    ?.filter((a): a is Extract<NeoAssertSpec, { kind: "count_min" }> => a.kind === "count_min" && a.tool === "file_write")
    .reduce((max, a) => Math.max(max, a.count ?? 0), 0);
  const observedWrites = artifacts.trace.filter((t) => t.name === "file_write").length;

  if (!declaredWrites) {
    // Nothing declared to check the appends against, so the rounds that ran are
    // the whole signal.
    return {
      name: "recurring",
      score: round2(artifactScore),
      detail: [
        `${ran}/${declared} round(s) ran`,
        "no round-count assertion declared",
        `score ${round2(artifactScore)}`,
      ].join("; "),
    };
  }

  const loggedScore = clamp100((Math.min(observedWrites, declaredWrites) / declaredWrites) * 100);
  const score = round2(clamp100(artifactScore * 0.6 + loggedScore * 0.4));
  return {
    name: "recurring",
    score,
    detail: [
      `${ran}/${declared} round(s) ran`,
      `${observedWrites} append(s) vs ${declaredWrites} declared`,
      `score ${score}`,
    ].join("; "),
  };
}

// ---------------------------------------------------------------------------
// Total
// ---------------------------------------------------------------------------

export interface ScoreInputs {
  fixture: NeoFixture;
  run: NeoRunResult;
  /** Seeds the case exposed, used for citation precision. */
  store: KnowledgeStore;
  /** Seeds a correct answer is expected to cite (fixture-declared). */
  expectedSeedIds?: readonly string[];
  /** Workspace root, so file assertions can be re-checked from disk. */
  workspace?: string;
}

/**
 * Build the artifacts object a scorer consumes: assertions plus the files the
 * fixture captured (from the trace, or read back from disk).
 */
export function collectArtifacts(inputs: ScoreInputs): NeoCaseArtifacts {
  const { fixture, run } = inputs;
  const files: Record<string, string> = { ...run.files };
  const root = inputs.workspace;
  for (const target of fixture.capture ?? []) {
    if (files[target] !== undefined || !root) continue;
    const full = path.resolve(root, target);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) files[target] = fs.readFileSync(full, "utf8");
    } catch {
      /* an unreadable artifact is reported as missing */
    }
  }
  const artifacts: NeoCaseArtifacts = {
    files,
    finalText: run.finalText,
    trace: run.trace,
    promptTokensPerStep: run.promptTokens,
    budgetExhausted: run.budgetExhausted,
    checks: [],
    citedSeedIds: extractCitations(run.finalText),
    rounds: run.rounds,
    clockIso: run.clockIso,
    resumedFrom: run.resumedFrom,
  };
  artifacts.checks = runAssertions(fixture, artifacts);
  return artifacts;
}

/** Combine the dimension scores into a weighted case total and verdict. */
export function scoreArtifacts(inputs: ScoreInputs): NeoCaseScore {
  const { fixture } = inputs;
  const artifacts = collectArtifacts(inputs);
  // Seeds the fixture declares as the expected citations (fixture-declared
  // through `asserts.answer_matches`, which names the seed id).
  const expected =
    inputs.expectedSeedIds ??
    fixture.asserts?.filter((a) => a.kind === "answer_matches").map((a) => a.value ?? "") ??
    [];

  const dimensions: NeoDimensionScore[] = [];
  const completion = scoreCompletion(fixture, artifacts);
  dimensions.push(completion);

  const expectsCitation = (fixture.seeds?.length ?? 0) > 0;
  const citation = expectsCitation ? scoreCitation(artifacts, inputs.store, expected) : null;
  if (citation) dimensions.push(citation);

  const flatness = artifacts.promptTokensPerStep.length >= 4 ? scoreFlatness(artifacts) : null;
  if (flatness) dimensions.push(flatness);

  const injected = artifacts.trace.some((t) => !t.ok);
  const recovery = injected ? scoreRecovery(artifacts) : null;
  if (recovery) dimensions.push(recovery);

  const recurring = fixture.dimension === "recurring" ? scoreRecurring(fixture, artifacts) : null;
  if (recurring) dimensions.push(recurring);

  // Weight only the dimensions this fixture actually exercised, renormalised.
  const total = round2(weightedTotal(dimensions));
  const bar = NEO_PASS_BAR;
  return {
    id: fixture.id,
    dimension: fixture.dimension,
    completion: completion.score,
    citation: citation?.score ?? null,
    flatness: flatness?.score ?? null,
    recovery: recovery?.score ?? null,
    recurring: recurring?.score ?? null,
    total,
    verdict: total >= bar ? "pass" : "fail",
    dimensions,
    checks: artifacts.checks,
    steps: inputs.run.steps,
    finalText: artifacts.finalText,
    durationMs: inputs.run.durationMs,
  };
}

/** Weight a partial set of dimensions by the N20 weights, renormalised. */
export function weightedTotal(dimensions: readonly NeoDimensionScore[]): number {
  const weightFor = (name: NeoDimensionScore["name"]): number =>
    name === "recurring" ? NEO_WEIGHTS.completion : NEO_WEIGHTS[name];
  const totalWeight = dimensions.reduce((sum, d) => sum + weightFor(d.name), 0);
  if (totalWeight <= 0) return 0;
  const weighted = dimensions.reduce((sum, d) => sum + d.score * weightFor(d.name), 0);
  // Rounded here as well as in the callers, so a renormalised set of perfect
  // dimensions reports exactly 100 rather than 99.99999999999999.
  return round2(weighted / totalWeight);
}

/** Suite total: the mean of the per-case weighted totals. */
export function suiteResult(cases: readonly NeoCaseScore[]): NeoSuiteResult {
  // An empty case set is not a pass: nothing ran, so nothing was verified. This
  // keeps a broken suite discovery from reporting a green gate.
  if (cases.length === 0) {
    return {
      version: NEO_HARNESS_VERSION,
      passBar: NEO_PASS_BAR,
      cases: [],
      total: 0,
      passed: 0,
      failed: 1,
      verdict: "fail",
    };
  }
  const total = round2(cases.reduce((sum, c) => sum + c.total, 0) / cases.length);
  const passed = cases.filter((c) => c.verdict === "pass").length;
  return {
    version: NEO_HARNESS_VERSION,
    passBar: NEO_PASS_BAR,
    cases: [...cases],
    total,
    passed,
    // The count of cases that did not clear the bar. An empty case set counts as
    // one failed suite, because nothing ran and nothing was verified.
    failed: cases.length === 0 ? 1 : cases.length - passed,
    verdict: passed === cases.length ? "pass" : "fail",
  };
}
