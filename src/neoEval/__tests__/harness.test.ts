/**
 * End-to-end tests for the N20 long-horizon harness.
 *
 * These drive the *production* agent loop with the scripted model, so they are
 * the acceptance tests the task contract asks for: the whole suite must run in
 * CI-like local mode (offline, deterministic, no network, no real model) and
 * every declared case must clear the bar.
 *
 * The suite is small enough to run all ten fixtures here, but the per-case tests
 * pin the behaviours that are easy to lose: the interrupt/resume path, the
 * recurring round replay, the flatness signal and the default verifier.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NEO_FIXTURES, fixtureById } from "../../../evals/neo/fixtures.js";
import { evaluateFixture, runFixture, defaultVerifierScript, defaultToolNames } from "../harness.js";
import { suiteResult } from "../scoring.js";
import { NEO_HARNESS_VERSION, NEO_PASS_BAR, type NeoFixture } from "../types.js";

/** A minimal fixture that writes one file and finishes. */
const simpleFixture = (): NeoFixture => ({
  id: "simple",
  name: "simple",
  dimension: "completion",
  prompt: "Write simple.md containing the word done.",
  tools: ["file_read", "file_write", "file_list"],
  script: {
    steps: [
      { text: "Writing the file.", calls: [{ tool: "file_write", args: { path: "simple.md", content: "done\n" } }] },
      { text: "simple.md contains the word done." },
    ],
  },
  capture: ["simple.md"],
  asserts: [
    { kind: "file_exists", path: "simple.md" },
    { kind: "file_matches", path: "simple.md", value: "done" },
  ],
});

describe("fixture catalogue", () => {
  it("declares exactly ten fixtures with unique ids", () => {
    assert.equal(NEO_FIXTURES.length, 10);
    assert.equal(new Set(NEO_FIXTURES.map((f) => f.id)).size, 10);
  });

  it("covers every scored dimension", () => {
    const dimensions = new Set(NEO_FIXTURES.map((f) => f.dimension));
    for (const expected of ["completion", "citation", "flatness", "recovery", "recurring"]) {
      assert.ok(dimensions.has(expected as never), `no fixture exercises ${expected}`);
    }
  });

  it("resolves a fixture by id", () => {
    assert.equal(fixtureById("research-to-report")?.id, "research-to-report");
    assert.equal(fixtureById("nope"), undefined);
  });

  it("declares the default verifier only where a fixture omits one", () => {
    assert.equal(fixtureById("research-to-report")?.verifierScript, undefined);
    assert.equal(fixtureById("restart-from-step")?.verifierScript, undefined);
  });
});

describe("defaultVerifierScript", () => {
  it("reads back the captured artifact before passing", () => {
    const script = defaultVerifierScript(simpleFixture());
    assert.equal(script.steps.length, 2);
    assert.equal(script.steps[0]!.calls?.[0]?.tool, "file_read");
    assert.equal(script.steps[1]!.when?.afterCall, "file_read");
  });

  it("still passes for a fixture with no capture path", () => {
    const script = defaultVerifierScript({ ...simpleFixture(), capture: [] });
    assert.equal(script.steps.length, 1);
    const verdict = JSON.parse(script.steps[0]!.text!);
    assert.equal(verdict.verdict, "pass");
  });
});

describe("runFixture on the production loop", () => {
  it("delivers the artifact and a grounded final answer", async () => {
    const { result } = await runFixture({ fixture: simpleFixture() });
    assert.equal(result.files["simple.md"], "done\n");
    assert.match(result.finalText, /done/);
    assert.ok(result.steps >= 1, `expected at least one step, got ${result.steps}`);
  });

  it("exercises the default verifier, which inspects the artifact", async () => {
    const { result } = await runFixture({ fixture: simpleFixture() });
    assert.ok(result.trace.some((t) => t.name === "file_read"), "the verifier should read the artifact");
  });

  it("registers the production file tools plus the knowledge lookup", () => {
    const names = defaultToolNames();
    for (const expected of ["file_read", "file_write", "file_list", "kb_search"]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
  });

  it("records prompt-token samples for the flatness dimension", async () => {
    const { result } = await runFixture({ fixture: simpleFixture() });
    assert.ok(result.promptTokens.length >= 1);
    assert.ok(result.promptTokens.every((n) => n > 0));
  });

  it("reports budget exhaustion rather than pretending the run finished", async () => {
    const fixture: NeoFixture = {
      ...simpleFixture(),
      maxSteps: 1,
      script: { steps: [{ text: "never stopping", calls: [{ tool: "file_list", args: { path: "." } }] }] },
    };
    const { result } = await runFixture({ fixture });
    assert.equal(result.budgetExhausted, true);
  });
});

describe("restart-from-step", () => {
  it("interrupts at the declared point and resumes from the checkpoint", async () => {
    const fixture = fixtureById("restart-from-step")!;
    const { result } = await runFixture({ fixture });
    assert.equal(result.resumedFrom, true, "the run should have been resumed");
    assert.ok(result.files["findings.md"] !== undefined, "the artifact should survive the restart");
    // The two lookups straddle the restart: one before, one after.
    assert.ok(result.trace.filter((t) => t.name === "kb_search").length >= 2);
  });

  it("does not resume a run with no interrupt point", async () => {
    const { result } = await runFixture({ fixture: simpleFixture() });
    assert.equal(result.resumedFrom, false);
  });
});

describe("recurring rounds", () => {
  it("runs one fresh round per declared instant and keeps the script replaying", async () => {
    const fixture = fixtureById("recurring-tracker")!;
    const { result } = await runFixture({ fixture });
    assert.equal(result.rounds, fixture.rounds!.length);
    // Each round appends, so the tracker accumulates rather than being rewritten.
    assert.equal(result.files["tracker.md"]?.trim().split("\n").length, fixture.rounds!.length);
  });

  it("reports the mock clock's final instant", async () => {
    const fixture = fixtureById("recurring-tracker")!;
    const { result } = await runFixture({ fixture });
    assert.equal(result.clockIso, "2026-01-26T09:00:00.000Z");
  });
});

describe("fault injection", () => {
  it("fails a call until the hook lets it through, and still delivers", async () => {
    let attempts = 0;
    const fixture: NeoFixture = {
      ...simpleFixture(),
      script: {
        steps: [
          { text: "first try", calls: [{ tool: "file_write", args: { path: "simple.md", content: "done\n" } }] },
          { text: "second try", calls: [{ tool: "file_write", args: { path: "simple.md", content: "done\n" } }] },
          { text: "done" },
        ],
        onCall: (tool: string) => {
          if (tool !== "file_write") return undefined;
          attempts += 1;
          return attempts < 2 ? "injected failure: file_write" : undefined;
        },
      },
    };
    const { result } = await runFixture({ fixture });
    assert.equal(attempts, 2);
    assert.equal(result.files["simple.md"], "done\n");
  });
});

describe("the full suite as the acceptance gate", () => {
  it("runs every fixture offline and clears the bar", async () => {
    const scores = [];
    for (const fixture of NEO_FIXTURES) {
      const { score } = await evaluateFixture(fixture);
      scores.push(score);
    }
    const result = suiteResult(scores);
    assert.equal(result.version, NEO_HARNESS_VERSION);
    assert.equal(result.cases.length, NEO_FIXTURES.length);
    assert.equal(result.passed, NEO_FIXTURES.length, `failing cases: ${result.cases.filter((c) => c.verdict !== "pass").map((c) => `${c.id}(${c.total})`).join(", ")}`);
    assert.equal(result.failed, 0);
    assert.equal(result.verdict, "pass");
    assert.ok(result.total >= NEO_PASS_BAR);
  });
});
