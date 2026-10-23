/**
 * V14 acceptance tests for the joined design pipeline.
 *
 * Every effect is injected: the model is a fake, the linter is a fake, the
 * critique is the deterministic mock, and the generator is a deterministic
 * function. No network, no real Ollama, and the only filesystem access is a
 * per-test temporary directory. That is what makes the loop's behaviour
 * (route, stage order, bounded loops, honest delta) assertable rather than
 * merely observable.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  PIPELINE_MAX_BUILD_ROUNDS,
  PIPELINE_MAX_CRITIQUE_ROUNDS,
  PIPELINE_MAX_FILES,
  PIPELINE_PASS_THRESHOLD,
  applyFixInstruction,
  createPipelineWorkspace,
  generateSite,
  isRtlFixture,
  measureCoverage,
  routeUiModel,
  runDesignPipeline,
  writeSiteFiles,
  type DesignPipelineFixture,
  type DesignPipelineUsage,
  type GenerateStageInput,
  type PipelineScore,
} from "../pipeline.js";
import type { BlockHit } from "../retrieval.js";
import type { DesignBrief } from "../brief.js";
import type { LintResult } from "../tokenLint.js";
import type { FailoverProvider } from "../../llm/failover.js";

/** A local provider, which needs no credential. */
function provider(id: string, model: string): FailoverProvider {
  return { id, kind: "ollama", baseUrl: "http://local", model, apiKeyEnv: "", enabled: true };
}

/** A cloud provider, which is only usable when its key is present in the env. */
function cloud(id: string, model: string, keyEnv: string): FailoverProvider {
  return { id, kind: "openai-compatible", baseUrl: `https://${id}.example/v1`, model, apiKeyEnv: keyEnv, enabled: true };
}

/** A design brief the generator can consume without touching a model. */
function brief(overrides: Partial<DesignBrief> = {}): DesignBrief {
  return {
    mood: "Calm and clear",
    summary: "A calm editorial landing page",
    palette: [
      { role: "background", hex: "#fbfbf8", usage: "Page background." },
      { role: "foreground", hex: "#1c1d19", usage: "Body text." },
      { role: "primary", hex: "#2f6f5e", usage: "Primary actions." },
    ],
    fonts: [{ role: "sans", family: "Inter", fallback: "system-ui, sans-serif" }],
    layout: "Single column with a centered hero above the fold.",
    layoutPrinciples: ["Mobile-first single column."],
    imageNeeds: [],
    accessibility: ["AA contrast throughout."],
    rtl: false,
    tokens: { "--background": "#fbfbf8", "--foreground": "#1c1d19", "--primary": "#2f6f5e" },
    ...overrides,
  };
}

function fixture(overrides: Partial<DesignPipelineFixture> = {}): DesignPipelineFixture {
  return {
    id: "test-fixture",
    prompt: "Design a responsive marketing landing page for a specialty coffee roastery.",
    locale: "en",
    direction: "ltr",
    expectations: { must: ["Northlight Roast"], mustNot: ["lorem ipsum"] },
    ...overrides,
  };
}

/** A fake linter whose score is driven by a mutable knob. */
function fakeLinter(initial: number) {
  const state = { score: initial, calls: 0 };
  return {
    state,
    async lintSite(): Promise<LintResult> {
      state.calls += 1;
      return {
        score: state.score,
        issues: [],
        metrics: {
          files: 1,
          rawColors: 0,
          arbitraryPx: 0,
          fontFamilies: 1,
          emoji: 0,
          gradients: 0,
          missingAlt: 0,
          rtlReady: true,
        },
      };
    },
  };
}

/** A fake chat client that answers the brief request and records the model. */
function fakeModel() {
  const calls: string[] = [];
  return {
    calls,
    async chat(options: { model: string }): Promise<{
      content: string;
      toolCalls: Array<{ function: { name: string; arguments: unknown } }>;
      model: string;
      usage: DesignPipelineUsage;
    }> {
      calls.push(options.model);
      return {
        content: "mock brief",
        // The brief call makes no tool calls; the fallback path still reads the
        // list, so it must be present.
        toolCalls: [],
        model: options.model,
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      };
    },
  };
}

/** A deterministic generator that writes a minimal lintable page. */
function stubGenerator(input: GenerateStageInput) {
  return generateSite({ ...input, must: input.must ?? [], blocks: input.blocks ?? [] });
}

const workspaces: string[] = [];
after(() => {
  for (const dir of workspaces) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-pipeline-test-"));
  workspaces.push(dir);
  return dir;
}

const score = (total: number): PipelineScore => ({
  lint: total,
  critique: total,
  build: 100,
  total,
  verdict: total >= PIPELINE_PASS_THRESHOLD ? "pass" : "fail",
  coverage: 1,
});

describe("pipeline: stage order and routing", () => {
  it("runs every stage once, in pipeline order", async () => {
    const result = await runDesignPipeline({
      workspace: workspace(),
      fixture: fixture(),
      cfg: { model: "configured", workspace: os.tmpdir(), coding: { enabled: true, chain: ["strong"] }, failover: { providers: [provider("p1", "strong")] } },
      model: fakeModel() as never,
      generateSite: stubGenerator,
      linter: fakeLinter(90),
      skipBuild: true,
      score: async () => score(90),
    });
    assert.deepEqual(
      result.stages.map((stage) => stage.stage),
      ["classify", "brief", "examples", "scaffold", "generate", "autofix", "build", "screenshot", "critique"],
    );
  });

  it("routes the UI task to the strongest available model", async () => {
    const result = await runDesignPipeline({
      workspace: workspace(),
      fixture: fixture(),
      cfg: {
        model: "configured",
        workspace: os.tmpdir(),
        coding: { enabled: true, chain: ["ghost", "strong"] },
        failover: { providers: [provider("p1", "strong")] },
      },
      model: fakeModel() as never,
      generateSite: stubGenerator,
      linter: fakeLinter(90),
      skipBuild: true,
      score: async () => score(90),
    });
    assert.equal(result.route.model, "strong");
    assert.equal(result.route.source, "coding");
    assert.equal(result.model.models[0], "strong");
  });

  it("does not route to a chain model with no live provider", async () => {
    const result = await runDesignPipeline({
      workspace: workspace(),
      fixture: fixture(),
      cfg: { model: "configured", workspace: os.tmpdir(), coding: { enabled: true, chain: ["ghost"] }, failover: { providers: [] } },
      model: fakeModel() as never,
      generateSite: stubGenerator,
      linter: fakeLinter(90),
      skipBuild: true,
      score: async () => score(90),
    });
    assert.equal(result.route.model, "configured");
    assert.equal(result.route.source, "default");
  });

  it("does not route to a cloud provider whose key is missing", async () => {
    // The real credential rule, exercised through the pipeline: a keyless cloud
    // provider is not available, so the run must not be routed to it.
    const result = await runDesignPipeline({
      workspace: workspace(),
      fixture: fixture(),
      cfg: {
        model: "configured",
        workspace: os.tmpdir(),
        coding: { enabled: true, chain: ["strong"] },
        failover: { providers: [cloud("p1", "strong", "MISSING_KEY")] },
        env: {},
      },
      model: fakeModel() as never,
      generateSite: stubGenerator,
      linter: fakeLinter(90),
      skipBuild: true,
      score: async () => score(90),
    });
    assert.equal(result.route.model, "configured");
    assert.equal(result.route.source, "default");
    assert.equal(result.route.provider, "");
  });

  it("reports a passed route summary naming the model", async () => {
    const result = await runDesignPipeline({
      workspace: workspace(),
      fixture: fixture(),
      cfg: { model: "m", workspace: os.tmpdir() },
      model: fakeModel() as never,
      generateSite: stubGenerator,
      linter: fakeLinter(90),
      skipBuild: true,
      score: async () => score(90),
    });
    assert.match(result.stages[0]!.summary, /classify: ok/);
    assert.match(result.stages[0]!.summary, /model m/);
  });
});

describe("pipeline: bounded loops", () => {
  it("runs a real build through the scaffold's own entrypoint", async () => {
    const dir = workspace();
    const result = await runDesignPipeline({
      workspace: dir,
      fixture: fixture(),
      cfg: { model: "m", workspace: os.tmpdir() },
      model: fakeModel() as never,
      generateSite: stubGenerator,
      linter: fakeLinter(100),
      // A real build: the scaffold writes `build.mjs` and the loop must converge
      // on it rather than assuming success.
      skipBuild: false,
      score: async () => score(90),
    });
    const build = result.stages.find((stage) => stage.stage === "build");
    assert.ok(build, "expected a build stage");
    assert.equal(build!.ok, true, `build stage failed: ${build!.summary}`);
    assert.match(build!.summary, /build ok/);
    // The artifact the build check verified is real, not a stub.
    assert.equal(fs.existsSync(path.join(result.workspace, "dist", "index.html")), true);
  });

  it("keeps critique rounds within the configured bound", async () => {
    const result = await runDesignPipeline({
      workspace: workspace(),
      fixture: fixture(),
      cfg: { model: "m", workspace: os.tmpdir() },
      model: fakeModel() as never,
      generateSite: stubGenerator,
      linter: fakeLinter(90),
      skipBuild: true,
      maxCritiqueRounds: 2,
      score: async () => score(90),
    });
    // The loop stops as soon as the rubric clears the threshold, so a high
    // critique score means a single verdict and no repair round at all.
    const critiqueRounds = result.stages.filter((record) => record.stage === "critique");
    assert.ok(critiqueRounds.length <= 1 + PIPELINE_MAX_CRITIQUE_ROUNDS);
    assert.ok(critiqueRounds.every((record) => record.round <= 2), "critique rounds exceed the configured bound");
  });

  it("honours an explicit round bound of zero", async () => {
    const result = await runDesignPipeline({
      workspace: workspace(),
      fixture: fixture(),
      cfg: { model: "m", workspace: os.tmpdir() },
      model: fakeModel() as never,
      generateSite: stubGenerator,
      linter: fakeLinter(10),
      skipBuild: true,
      maxCritiqueRounds: 0,
      score: async () => score(90),
    });
    // A bound of zero means one verdict and no repair rounds, whatever the score.
    const critiqueRounds = result.stages.filter((record) => record.stage === "critique");
    assert.equal(critiqueRounds.length, 1);
    assert.equal(critiqueRounds[0]!.round, 0);
  });
});

describe("pipeline: honest delta and file budget", () => {
  it("reports improvement against the starting state of the same workspace", async () => {
    let call = 0;
    const result = await runDesignPipeline({
      workspace: workspace(),
      fixture: fixture(),
      cfg: { model: "m", workspace: os.tmpdir() },
      model: fakeModel() as never,
      generateSite: stubGenerator,
      linter: fakeLinter(90),
      skipBuild: true,
      score: async () => score(call++ === 0 ? 40 : 90),
    });
    assert.equal(result.baselineTotal, 40);
    assert.equal(result.score.total, 90);
    assert.equal(result.improved, true);
  });

  it("does not claim improvement when the final score ties the baseline", async () => {
    const result = await runDesignPipeline({
      workspace: workspace(),
      fixture: fixture(),
      cfg: { model: "m", workspace: os.tmpdir() },
      model: fakeModel() as never,
      generateSite: stubGenerator,
      linter: fakeLinter(90),
      skipBuild: true,
      score: async () => score(70),
    });
    assert.equal(result.improved, false);
  });

  it("caps generated files at the budget and notes the truncation", async () => {
    const result = await runDesignPipeline({
      workspace: workspace(),
      fixture: fixture(),
      cfg: { model: "m", workspace: os.tmpdir() },
      model: fakeModel() as never,
      generateSite: () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < PIPELINE_MAX_FILES + 5; i++) files[`page-${i}.html`] = `<p>${i}</p>`;
        return files;
      },
      linter: fakeLinter(90),
      skipBuild: true,
      score: async () => score(90),
    });
    assert.equal(Object.keys(result.notes).length >= 0, true);
    assert.equal(result.notes.some((note) => note.includes(String(PIPELINE_MAX_FILES))), true);
  });
});

describe("pipeline: generator and fixer", () => {
  it("emits the brief's font families and tokens", () => {
    const files = generateSite({
      workspace: os.tmpdir(),
      files: {},
      brief: brief({
        fonts: [
          { role: "sans", family: "Inter", fallback: "system-ui" },
          { role: "heading", family: "Fraunces", fallback: "Georgia" },
        ],
      }),
      direction: "ltr",
      locale: "en",
      prompt: "prompt",
      must: [],
      mustNot: [],
      blocks: [],
    });
    assert.match(files["globals.css"]!, /--font-sans: "Inter", system-ui;/);
    assert.match(files["globals.css"]!, /--font-heading: "Fraunces", Georgia;/);
    assert.match(files["globals.css"]!, /font-family: var\(--font-heading\)/);
    assert.match(files["index.html"]!, /<html lang="en" dir="ltr">/);
  });

  it("writes a build entrypoint so the build check runs a command", () => {
    const files = generateSite({
      workspace: os.tmpdir(),
      files: {},
      brief: brief(),
      direction: "ltr",
      locale: "en",
      prompt: "prompt",
      must: [],
      mustNot: [],
      blocks: [],
    });
    assert.match(files["build.mjs"]!, /import fs from "node:fs";/);
    assert.match(files["build.mjs"]!, /dist/);
  });

  it("renders an RTL document with a logical-property layout", () => {
    const files = generateSite({
      workspace: os.tmpdir(),
      files: {},
      brief: brief({ rtl: true }),
      direction: "rtl",
      locale: "ar",
      prompt: "صفحة هبوط",
      must: [],
      mustNot: [],
      blocks: [],
    });
    assert.match(files["index.html"]!, /<html lang="ar" dir="rtl">/);
    assert.match(files["globals.css"]!, /margin-inline: auto/);
    assert.match(files["globals.css"]!, /padding-inline: 1\.25rem/);
  });

  it("removes a forbidden string and adds a missing required one", () => {
    const files = {
      "index.html": `<!doctype html><html lang="en"><body><main><p>lorem ipsum dolor</p></main></body></html>`,
    };
    const fixed = applyFixInstruction({
      workspace: os.tmpdir(),
      files,
      instruction: "remove placeholder copy",
      must: ["Our roasts"],
      mustNot: ["lorem ipsum"],
    });
    assert.equal(fixed["index.html"]!.includes("lorem ipsum"), false);
    assert.equal(fixed["index.html"]!.includes("Our roasts"), true);
  });
});

describe("pipeline: helpers", () => {
  it("creates a workspace inside a root that does not exist yet", () => {
    // `mkdtemp` only creates the leaf, so a caller-supplied root (a cleaned
    // `out/`, a fresh checkout) must be created first or the whole gate fails.
    const base = path.join(workspace(), "nested", "root");
    assert.equal(fs.existsSync(base), false);
    const created = createPipelineWorkspace(base);
    assert.equal(fs.existsSync(created), true);
    assert.ok(created.startsWith(base));
  });

  it("measures expectation coverage the way the V1 harness does", () => {
    const coverage = measureCoverage(fixture(), {
      "index.html": "Northlight Roast page",
      "globals.css": "/* no placeholder */",
    });
    assert.equal(coverage, 1);
  });

  it("measures partial coverage", () => {
    // `mustNot` is satisfied (the placeholder is absent) and the single `must`
    // string is missing, so one of two expectations holds.
    const coverage = measureCoverage(fixture(), { "index.html": "unrelated copy" });
    assert.equal(coverage, 0.5);
  });

  it("treats an empty expectation list as full coverage", () => {
    assert.equal(measureCoverage(fixture({ expectations: {} }), {}), 1);
  });

  it("detects RTL fixtures from locale and explicit direction", () => {
    assert.equal(isRtlFixture("ar"), true);
    assert.equal(isRtlFixture("en"), false);
    assert.equal(isRtlFixture("en", "rtl"), true);
    assert.equal(isRtlFixture("ar", "ltr"), false);
  });

  it("exposes the round bounds as documented", () => {
    assert.equal(PIPELINE_MAX_BUILD_ROUNDS, 3);
    assert.equal(PIPELINE_MAX_CRITIQUE_ROUNDS, 2);
  });

  it("routes through the same adapter the pipeline uses", () => {
    const route = routeUiModel({
      model: "configured",
      workspace: os.tmpdir(),
      coding: { enabled: false, chain: [] },
      failover: { providers: [provider("p1", "strong")] },
    });
    assert.equal(route.model, "strong");
    assert.equal(route.source, "strongest");
  });
});
