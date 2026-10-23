/**
 * Unit tests for the long-horizon scoring dimensions (N20).
 *
 * The dimension scorers are pure functions over {@link NeoCaseArtifacts}, so they
 * are cheap to test directly: each case pins the arithmetic that the suite
 * depends on, so a later change to a weight or a threshold is a visible test
 * failure rather than a silently shifted baseline.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  runAssertions,
  scoreCitation,
  scoreCompletion,
  scoreFlatness,
  scoreRecovery,
  scoreRecurring,
  suiteResult,
  weightedTotal,
} from "../scoring.js";
import { KnowledgeStore } from "../knowledge.js";
import type { NeoAssertSpec, NeoCaseArtifacts, NeoDimensionScore, NeoFixture } from "../types.js";

function artifacts(overrides: Partial<NeoCaseArtifacts> = {}): NeoCaseArtifacts {
  return {
    files: {},
    finalText: "",
    trace: [],
    promptTokensPerStep: [],
    budgetExhausted: false,
    checks: [],
    citedSeedIds: [],
    rounds: 0,
    clockIso: "2026-01-05T09:00:00.000Z",
    resumedFrom: false,
    ...overrides,
  };
}

const seeds = [
  { id: "kb-1", title: "One", body: "The first seeded document.", tags: ["one"] },
  { id: "kb-2", title: "Two", body: "The second seeded document.", tags: ["two"] },
];
const store = new KnowledgeStore(seeds);

const fixture = (overrides: Partial<NeoFixture> = {}): NeoFixture => ({
  id: "case",
  name: "case",
  dimension: "completion",
  prompt: "do the thing",
  script: { steps: [] },
  ...overrides,
});

describe("runAssertions", () => {
  it("passes file_exists only for a captured artifact", () => {
    const art = artifacts({ files: { "report.md": "body" } });
    const [hit, miss] = runAssertions(
      fixture({ asserts: [{ kind: "file_exists", path: "report.md" }, { kind: "file_exists", path: "gone.md" }] }),
      art,
    );
    assert.equal(hit!.ok, true);
    assert.equal(miss!.ok, false);
  });

  it("passes file_matches only when the regex matches the captured content", () => {
    const art = artifacts({ files: { "report.md": "the 7 percent duty" } });
    const [yes, no] = runAssertions(
      fixture({
        asserts: [
          { kind: "file_matches", path: "report.md", value: "7 percent" },
          { kind: "file_matches", path: "report.md", value: "9 percent" },
        ],
      }),
      art,
    );
    assert.equal(yes!.ok, true);
    assert.equal(no!.ok, false);
  });

  it("rejects an invalid regex instead of throwing", () => {
    const art = artifacts({ files: { "report.md": "body" } });
    const [result] = runAssertions(fixture({ asserts: [{ kind: "file_matches", path: "report.md", value: "(" }] }), art);
    assert.equal(result!.ok, false);
    assert.match(result!.detail, /invalid regex/);
  });

  it("passes answer_matches on a case-insensitive substring", () => {
    const art = artifacts({ finalText: "The answer is Recovered." });
    const [result] = runAssertions(fixture({ asserts: [{ kind: "answer_matches", value: "recovered" }] }), art);
    assert.equal(result!.ok, true);
  });

  it("passes trace_used and trace_not_used against the trace", () => {
    const art = artifacts({ trace: [{ name: "kb_search", ok: true, summary: "" }] });
    const [used, notUsed] = runAssertions(
      fixture({
        asserts: [
          { kind: "trace_used", tool: "kb_search" },
          { kind: "trace_not_used", tool: "file_edit" },
        ],
      }),
      art,
    );
    assert.equal(used!.ok, true);
    assert.equal(notUsed!.ok, true);
  });

  it("passes count_min on the number of matching calls", () => {
    const art = artifacts({
      trace: [
        { name: "kb_search", ok: true, summary: "" },
        { name: "kb_search", ok: true, summary: "" },
      ],
    });
    const [enough, tooFew] = runAssertions(
      fixture({
        asserts: [
          { kind: "count_min", tool: "kb_search", count: 2 },
          { kind: "count_min", tool: "kb_search", count: 3 },
        ],
      }),
      art,
    );
    assert.equal(enough!.ok, true);
    assert.equal(tooFew!.ok, false);
  });

  it("passes resumed only when the run was interrupted and resumed", () => {
    const [resumed] = runAssertions(fixture({ asserts: [{ kind: "resumed" }] }), artifacts({ resumedFrom: true }));
    const [never] = runAssertions(fixture({ asserts: [{ kind: "resumed" }] }), artifacts({ resumedFrom: false }));
    assert.equal(resumed!.ok, true);
    assert.equal(never!.ok, false);
  });

  it("labels each assertion kind for the recorded baseline", () => {
    const specs: NeoAssertSpec[] = [
      { kind: "resumed" },
      { kind: "trace_not_used", tool: "file_edit" },
      { kind: "count_min", tool: "kb_search", count: 2 },
    ];
    const results = runAssertions(fixture({ asserts: specs }), artifacts({}));
    assert.deepEqual(
      results.map((r) => r.label),
      ["resumed:checkpoint", "trace_not_used:file_edit", "count_min:kb_search:2"],
    );
  });
});

describe("scoreCompletion", () => {
  it("scores the share of assertions that held", () => {
    const art = artifacts({
      finalText: "done",
      checks: [{ kind: "file_exists", label: "a", ok: true, detail: "" }],
    });
    assert.equal(scoreCompletion(fixture(), art).score, 100);
  });

  it("returns 0 when a fixture declared no assertions", () => {
    assert.equal(scoreCompletion(fixture(), artifacts()).score, 0);
  });

  it("zeroes a run that produced no final answer", () => {
    const art = artifacts({
      finalText: "   ",
      checks: [{ kind: "file_exists", label: "a", ok: true, detail: "" }],
    });
    const result = scoreCompletion(fixture(), art);
    assert.equal(result.score, 0);
    assert.match(result.detail, /no final answer/);
  });

  it("halves the credit when the step budget was exhausted", () => {
    const art = artifacts({
      finalText: "done",
      budgetExhausted: true,
      checks: [{ kind: "file_exists", label: "a", ok: true, detail: "" }],
    });
    const result = scoreCompletion(fixture(), art);
    assert.equal(result.score, 50);
    assert.match(result.detail, /half credit/);
  });
});

describe("scoreCitation", () => {
  it("scores precision times recall over the seeded sources", () => {
    const art = artifacts({ citedSeedIds: ["kb-1", "kb-2"], finalText: "[seed:kb-1] [seed:kb-2]" });
    // precision 1 (both known), recall 1 (both expected) -> 100
    assert.equal(scoreCitation(art, store, ["kb-1", "kb-2"]).score, 100);
  });

  it("penalises an invented source", () => {
    const art = artifacts({ citedSeedIds: ["kb-1", "kb-999"], finalText: "[seed:kb-1] [seed:kb-999]" });
    // precision 1/2, recall 1 -> 50
    const result = scoreCitation(art, store, ["kb-1"]);
    assert.equal(result.score, 50);
    assert.match(result.detail, /unknown source\(s\): kb-999/);
  });

  it("penalises a seed that was expected but never cited", () => {
    const art = artifacts({ citedSeedIds: ["kb-1"], finalText: "[seed:kb-1]" });
    // precision 1, recall 1/2 -> 50
    assert.equal(scoreCitation(art, store, ["kb-1", "kb-2"]).score, 50);
  });

  it("scores 0 when the answer cites nothing", () => {
    const result = scoreCitation(artifacts(), store, ["kb-1"]);
    assert.equal(result.score, 0);
    assert.match(result.detail, /no \[seed:ID\]/);
  });
});

describe("scoreFlatness", () => {
  const flat = [1000, 1010, 1005, 1020, 1015];

  it("treats small token wobble as flat", () => {
    const result = scoreFlatness(artifacts({ promptTokensPerStep: flat }));
    assert.equal(result.score, 100);
    assert.match(result.detail, /flat up to 1\.1x/);
  });

  it("scores growth above the flat band strictly below a flat run", () => {
    const result = scoreFlatness(artifacts({ promptTokensPerStep: [1000, 1200, 1400, 1600, 1800] }));
    assert.ok(result.score > 0, "a moderately growing run is still partly credited");
    assert.ok(result.score < 100, `expected partial credit, got ${result.score}`);
  });

  it("scores a run whose prompt stayed flat", () => {
    const result = scoreFlatness(artifacts({ promptTokensPerStep: flat }));
    assert.equal(result.score, 100);
  });

  it("scores 0 for a run with too few samples to judge", () => {
    const result = scoreFlatness(artifacts({ promptTokensPerStep: [1000, 1100] }));
    assert.equal(result.score, 0);
    assert.match(result.detail, /too short to judge/);
  });

  it("scores a growing run strictly below a flat one", () => {
    const growing = [1000, 1400, 1800, 2200, 2600];
    const flatScore = scoreFlatness(artifacts({ promptTokensPerStep: flat })).score;
    const growthScore = scoreFlatness(artifacts({ promptTokensPerStep: growing })).score;
    assert.ok(growthScore < flatScore, `expected ${growthScore} < ${flatScore}`);
    assert.ok(growthScore >= 0);
  });

  it("caps a runaway growth at the limit rather than going negative", () => {
    const runaway = [1000, 9000, 9000, 9000];
    const result = scoreFlatness(artifacts({ promptTokensPerStep: runaway }));
    assert.ok(result.score >= 0 && result.score <= 100);
  });
});

describe("scoreRecovery", () => {
  it("is not exercised when nothing failed", () => {
    const result = scoreRecovery(artifacts({ trace: [{ name: "file_write", ok: true, summary: "" }] }));
    assert.equal(result.score, 100);
    assert.match(result.detail, /not exercised/);
  });

  it("credits a failure that was later retried successfully", () => {
    const art = artifacts({
      finalText: "done",
      trace: [
        { name: "file_write", ok: false, summary: "injected failure" },
        { name: "file_write", ok: true, summary: "ok" },
      ],
    });
    assert.equal(scoreRecovery(art).score, 100);
  });

  it("credits a failure survived to a delivered answer even without a retry", () => {
    const art = artifacts({
      finalText: "delivered",
      trace: [
        { name: "file_write", ok: false, summary: "injected failure" },
        { name: "file_read", ok: true, summary: "ok" },
      ],
    });
    assert.equal(scoreRecovery(art).score, 100);
  });

  it("scores 0 when a failure stopped the work", () => {
    const art = artifacts({
      finalText: "",
      trace: [
        { name: "file_write", ok: false, summary: "injected failure" },
        { name: "file_read", ok: true, summary: "ok" },
      ],
    });
    const result = scoreRecovery(art);
    assert.equal(result.score, 0);
    assert.match(result.detail, /unrecovered: file_write/);
  });

  it("ignores the harness's own run-level failure marker", () => {
    const art = artifacts({
      finalText: "delivered",
      trace: [
        { name: "file_write", ok: false, summary: "boom" },
        { name: "run", ok: false, summary: "cancelled" },
      ],
    });
    assert.equal(scoreRecovery(art).score, 100);
  });
});

describe("scoreRecurring", () => {
  it("scores the share of declared rounds that ran", () => {
    const art = artifacts({ rounds: 3 });
    const result = scoreRecurring(fixture({ rounds: [{ at: "a", name: "1" }, { at: "b", name: "2" }, { at: "c", name: "3" }, { at: "d", name: "4" }] }), art);
    assert.equal(result.score, 75);
    assert.match(result.detail, /no round-count assertion declared/);
  });

  it("is 100 when every round ran and the tracker logged each one", () => {
    // One append per round, so the trace shows the same four writes the four
    // declared rounds require.
    const art = artifacts({
      rounds: 4,
      trace: [
        { name: "file_write", ok: true, summary: "" },
        { name: "file_write", ok: true, summary: "" },
        { name: "file_write", ok: true, summary: "" },
        { name: "file_write", ok: true, summary: "" },
      ],
    });
    const result = scoreRecurring(
      fixture({
        rounds: [
          { at: "a", name: "1" },
          { at: "b", name: "2" },
          { at: "c", name: "3" },
          { at: "d", name: "4" },
        ],
        asserts: [{ kind: "count_min", tool: "file_write", count: 4 }],
      }),
      art,
    );
    assert.equal(result.score, 100);
    assert.match(result.detail, /4 append\(s\) vs 4 declared/);
  });

  it("penalises a tracker that logged fewer rounds than it ran", () => {
    const art = artifacts({ rounds: 4, trace: [{ name: "file_write", ok: true, summary: "" }] });
    const result = scoreRecurring(
      fixture({
        rounds: [
          { at: "a", name: "1" },
          { at: "b", name: "2" },
          { at: "c", name: "3" },
          { at: "d", name: "4" },
        ],
        asserts: [{ kind: "count_min", tool: "file_write", count: 2 }],
      }),
      art,
    );
    // The trace shows 1 append against 2 declared (50): the tracker restarted
    // from zero each round instead of accumulating. 4/4 rounds (100) * 0.6 +
    // 50 * 0.4 -> 80.
    assert.equal(result.score, 80);
    assert.match(result.detail, /1 append\(s\) vs 2 declared/);
  });

  it("scores 0 when no rounds were declared", () => {
    assert.equal(scoreRecurring(fixture(), artifacts()).score, 0);
  });
});

describe("weightedTotal and suiteResult", () => {
  it("weights dimensions by the N20 weights", () => {
    const dims: NeoDimensionScore[] = [
      { name: "completion", score: 100, detail: "" },
      { name: "citation", score: 50, detail: "" },
      { name: "flatness", score: 0, detail: "" },
      { name: "recovery", score: 100, detail: "" },
    ];
    // (100*.4 + 50*.2 + 0*.2 + 100*.2) / 1.0 = 70
    assert.equal(weightedTotal(dims), 70);
  });

  it("renormalises when a dimension is absent", () => {
    const dims: NeoDimensionScore[] = [
      { name: "completion", score: 100, detail: "" },
      { name: "citation", score: 100, detail: "" },
    ];
    // (100*.4 + 100*.2) / .6 = 100
    assert.equal(weightedTotal(dims), 100);
  });

  it("returns 0 for an empty dimension set", () => {
    assert.equal(weightedTotal([]), 0);
  });

  it("counts an empty case set as a failed suite", () => {
    const result = suiteResult([]);
    assert.equal(result.verdict, "fail");
    assert.equal(result.total, 0);
    // Nothing ran, so nothing was verified: that is a failed gate, not a pass.
    assert.equal(result.failed, 1);
  });

  it("passes only when every case cleared the bar", () => {
    const case_ = (id: string, total: number) => ({
      id,
      dimension: "completion" as const,
      completion: total,
      citation: null,
      flatness: null,
      recovery: null,
      recurring: null,
      total,
      verdict: (total >= 60 ? "pass" : "fail") as "pass" | "fail",
      dimensions: [],
      checks: [],
      steps: 1,
      finalText: "",
      durationMs: 0,
    });
    const passing = suiteResult([case_("a", 90), case_("b", 60)]);
    assert.equal(passing.verdict, "pass");
    assert.equal(passing.passed, 2);
    assert.equal(passing.failed, 0);
    const failing = suiteResult([case_("a", 90), case_("b", 59)]);
    assert.equal(failing.verdict, "fail");
    assert.equal(failing.failed, 1);
    assert.equal(failing.total, 74.5);
  });
});
