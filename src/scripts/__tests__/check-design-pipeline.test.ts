/**
 * V14 acceptance tests for the joined-pipeline gate.
 *
 * The gate's whole value is the comparison: it must score the pipeline against a
 * baseline on the *same* fixtures with the *same* scorer, and it must fail when
 * the pipeline is worse. These tests keep that honest without a model: the mock
 * client answers in-process, the baseline is a deliberately weak brief, and every
 * fixture is scored through the real `scoreFixture` build.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  createMockDesignModel,
  decidePass,
  describeUsage,
  loadCheckFixtures,
  runBaseline,
  runDesignPipelineCheck,
  type PipelineCheckResult,
} from "../check-design-pipeline.js";
import type { DesignPipelineFixture } from "../../design/pipeline.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-gate-test-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

/** A fixture that is cheap to build and deterministic to score. */
function fixture(id: string, overrides: Partial<DesignPipelineFixture> = {}): DesignPipelineFixture {
  return {
    id,
    prompt: `Design a marketing landing page for ${id}.`,
    locale: "en",
    direction: "ltr",
    expectations: { must: [`Brand ${id}`], mustNot: ["lorem ipsum"] },
    ...overrides,
  };
}

describe("gate: fixtures", () => {
  it("loads the V1 fixture set and normalises locale and direction", () => {
    const all = loadCheckFixtures();
    assert.ok(all.length >= 1, "expected at least one V1 fixture");
    assert.ok(all.every((entry) => entry.prompt.length > 0), "every fixture needs a prompt");
    assert.ok(all.every((entry) => entry.direction === "ltr" || entry.direction === "rtl"), "direction must be explicit");
    // The RTL half of the set is what makes the logical-property rules load-bearing.
    assert.ok(all.some((entry) => entry.direction === "rtl"), "expected at least one RTL fixture");
  });

  it("returns an empty list for a missing directory rather than throwing", () => {
    assert.deepEqual(loadCheckFixtures(path.join(root, "does-not-exist")), []);
  });
});

describe("gate: mock model", () => {
  it("answers in-process and records the model it was asked to use", async () => {
    const mock = createMockDesignModel("gate-model");
    const result = await mock.client.chat({ model: "gate-model", messages: [{ role: "user", content: "hi" }] });
    assert.equal(result.model, "gate-model");
    // The brief call makes no tool calls, but the field must exist: the fallback
    // path reads the list unconditionally.
    assert.deepEqual(result.toolCalls, []);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0]!.model, "gate-model");
  });
});

describe("gate: baseline", () => {
  it("builds a real site and earns its own build weight", async () => {
    const dir = path.join(root, "baseline-build");
    const score = await runBaseline(fixture("baseline-build"), dir);
    assert.equal(score.build, 100, "the baseline must build through its own entrypoint");
    assert.equal(fs.existsSync(path.join(dir, "dist", "index.html")), true, "the build artifact must exist");
    assert.ok(score.total > 0, "the baseline must score something");
  });

  it("keeps an RTL baseline in its own direction", async () => {
    const dir = path.join(root, "baseline-rtl");
    const score = await runBaseline(fixture("baseline-rtl", { locale: "ar", direction: "rtl" }), dir);
    const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
    assert.match(html, /dir="rtl"/);
    assert.match(html, /lang="ar"/);
    assert.equal(score.build, 100);
  });

  it("does not claim the fixture's copy coverage", async () => {
    // The baseline is the weakest brief the generator accepts: it has no
    // per-fixture content, so coverage must not be reported as full.
    const dir = path.join(root, "baseline-coverage");
    const score = await runBaseline(fixture("baseline-coverage"), dir);
    assert.ok(score.coverage < 1, `expected partial coverage, got ${score.coverage}`);
  });
});

describe("gate: whole check", () => {
  it("scores every fixture and never reports a regression it cannot detect", async () => {
    const result = await runDesignPipelineCheck({ outDir: path.join(root, "check") });
    assert.equal(result.fixtures, loadCheckFixtures().length);
    assert.equal(result.reports.length, result.fixtures);
    assert.equal(result.rtlFixtures, result.reports.filter((report) => report.direction === "rtl").length);
    // The acceptance criterion is "scores *above* the baseline", so a run that is
    // merely level with it must not pass. `passed` is therefore strictly stronger
    // than `notWorse`, and this run must clear that stronger bar.
    assert.equal(result.passed, true, "the pipeline must beat the baseline on the eval set");
    assert.equal(result.notWorse, true);
    assert.equal(result.regressedFixtures, 0, "the pipeline must not regress the eval set");
    assert.ok(result.improvedFixtures > 0, `expected at least one improved fixture, got ${result.improvedFixtures}`);
    assert.ok(result.deltaMean > 0, `expected a strictly positive delta, got ${result.deltaMean}`);

    for (const report of result.reports) {
      // Both sides go through the same scorer, so the delta is structurally real.
      assert.equal(typeof report.baseline.total, "number");
      assert.equal(typeof report.pipeline.total, "number");
      assert.equal(report.delta, report.pipeline.total - report.baseline.total);
      assert.equal(report.improved, report.delta > 0);
      // Every stage of the joined pipeline must have actually run.
      const stages = report.stages.map((stage) => stage.stage).join(",");
      for (const expected of ["classify", "brief", "examples", "scaffold", "generate", "autofix", "build", "screenshot", "critique"]) {
        assert.ok(stages.includes(expected), `fixture ${report.fixtureId} is missing stage ${expected}`);
      }
      assert.ok(report.modelCalls >= 1, "the mock model must be called at least once");
    }
  });

  it("routes every fixture to the mock UI model", async () => {
    const result = await runDesignPipelineCheck({ outDir: path.join(root, "check-route") });
    for (const report of result.reports) {
      assert.equal(report.route.model, "mock-ui-coder");
      assert.equal(report.route.source, "coding");
    }
  });

  it("reports no regression when a fixture set is empty", async () => {
    const result: PipelineCheckResult = await runDesignPipelineCheck({ outDir: path.join(root, "empty"), fixtures: [] });
    assert.equal(result.fixtures, 0);
    // An empty run has nothing to regress, so it must not be reported as a pass.
    assert.equal(result.passed, false);
  });
});

describe("gate: pass rule", () => {
  it("fails a run that only matches the baseline", () => {
    // The defect this guards: requiring only "nothing regressed" would report a run
    // that improved nothing as a success, which is the outcome the gate exists to
    // catch.
    assert.equal(decidePass({ fixtures: 12, regressedFixtures: 0, improvedFixtures: 0 }), false);
  });

  it("fails an empty run, which has nothing to compare", () => {
    assert.equal(decidePass({ fixtures: 0, regressedFixtures: 0, improvedFixtures: 0 }), false);
  });

  it("fails when anything regressed, even with improvements elsewhere", () => {
    assert.equal(decidePass({ fixtures: 12, regressedFixtures: 1, improvedFixtures: 6 }), false);
  });

  it("passes when at least one fixture improved and none regressed", () => {
    assert.equal(decidePass({ fixtures: 12, regressedFixtures: 0, improvedFixtures: 1 }), true);
  });
});

describe("gate: usage summary", () => {
  it("reports tokens and time in one line", () => {
    assert.equal(describeUsage({ promptTokens: 10, completionTokens: 4, durationMs: 90 }), "10 prompt / 4 completion tokens in 90ms");
  });
});
