/**
 * Neo N10: output types, effort levels and the routing model map.
 *
 * The acceptance criterion for this item is that Fast picks the small model, Max
 * the strong one, and that a Slides run lands on the slides pipeline. These tests
 * pin all three, plus the precedence rules a wrong order would silently break:
 * an explicit per-tool model beats the effort model, and an unset map leaves the
 * run exactly as it was before N10.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import type { Config } from "../../config.js";
import type { FailoverProvider } from "../failover.js";
import {
  EFFORT_LEVELS,
  OUTPUT_TYPES,
  effortModels,
  effortStepBudget,
  isEffortLevel,
  isOutputType,
  modelAbChain,
  normalizeEffort,
  outputTypeSuffix,
  outputTypeTools,
  perToolModels,
  providersForModels,
  resolveRouting,
  routingLabel,
} from "../router.js";

const FAST_MODEL = "qwen3-coder-30b";
const MAX_MODEL = "glm-5.4-flash:cloud";
const SLIDES_MODEL = "slides-specialist";

function provider(overrides: Partial<FailoverProvider> = {}): FailoverProvider {
  return {
    id: "ollama-local",
    kind: "ollama",
    baseUrl: "http://localhost:11434",
    model: FAST_MODEL,
    apiKeyEnv: "",
    enabled: true,
    ...overrides,
  };
}

/** Fast and Max are configured to two different models, so a wrong pick is visible. */
function cfg(overrides: Partial<Config> = {}): Config {
  return {
    model: MAX_MODEL,
    routing: {
      effort: { fast: FAST_MODEL, max: MAX_MODEL },
      perTool: { loam_studio: SLIDES_MODEL },
    },
    failover: {
      providers: [
        provider({ id: "local", model: FAST_MODEL }),
        provider({ id: "cloud", model: MAX_MODEL }),
        provider({ id: "studio", model: SLIDES_MODEL }),
      ],
    },
    coding: { enabled: true, chain: [MAX_MODEL], logEdits: false },
    ...overrides,
  } as unknown as Config;
}

const ENV = {};

describe("Neo N10 output types", () => {
  it("offers exactly the six composer output types", () => {
    assert.deepEqual([...OUTPUT_TYPES], ["auto", "text", "image", "video", "slides", "website"]);
  });

  it("accepts only the declared output types", () => {
    assert.equal(isOutputType("slides"), true);
    assert.equal(isOutputType("Slides"), false, "the server rejects mixed case so config typos fail loudly");
    assert.equal(isOutputType("pdf"), false);
    assert.equal(isOutputType(undefined), false);
  });

  it("maps each output type to its pipeline tools", () => {
    const registered = [
      "loam_document", "loam_studio", "loam_creative", "loam_canvas", "gen_image", "gen_video",
      "office_export", "web_scaffold", "preview_serve", "artifact_publish", "file_read",
    ];
    assert.deepEqual(outputTypeTools("slides", registered), ["loam_studio", "office_export"]);
    assert.deepEqual(outputTypeTools("website", registered), ["web_scaffold", "preview_serve", "artifact_publish"]);
    assert.deepEqual(outputTypeTools("image", registered), ["loam_creative", "loam_canvas", "gen_image"]);
    assert.deepEqual(outputTypeTools("auto", registered), [], "auto must not invent a pipeline");
    // A tool that is not registered is never offered, even if the type wants it.
    assert.deepEqual(outputTypeTools("video", ["loam_canvas"]), ["loam_canvas"]);
  });

  it("slides mode hits the slides pipeline in the system prompt", () => {
    const suffix = outputTypeSuffix("slides");
    assert.ok(suffix.includes("slides"), "the prompt names the deliverable");
    assert.ok(suffix.includes("loam_studio"), "the prompt names the slides tool");
    assert.ok(suffix.length > 120, "the suffix is a complete instruction, not a label");
    assert.equal(outputTypeSuffix("auto"), "", "auto must not change the prompt");
  });
});

describe("Neo N10 effort levels", () => {
  it("normalizes the composer's spellings", () => {
    assert.equal(normalizeEffort("Fast"), "fast");
    assert.equal(normalizeEffort("MAX"), "max");
    assert.equal(normalizeEffort("  fast  "), "fast");
    assert.equal(normalizeEffort("maximum"), "max");
    assert.equal(normalizeEffort("quick"), "fast");
    assert.equal(normalizeEffort(""), "");
    assert.equal(normalizeEffort("medium"), "", "an unknown level means 'leave it to the config'");
    assert.equal(normalizeEffort(undefined), "");
  });

  it("exposes only fast and max", () => {
    assert.deepEqual([...EFFORT_LEVELS], ["fast", "max"]);
    assert.equal(isEffortLevel("fast"), true);
    assert.equal(isEffortLevel("medium"), false);
  });

  it("Fast gets a smaller step budget than Max", () => {
    assert.ok(effortStepBudget("fast") < effortStepBudget("max"), "Fast is the cheaper depth");
  });
});

describe("Neo N10 routing map", () => {
  it("Fast picks the small model and Max the strong one", () => {
    const fast = resolveRouting({ cfg: cfg(), env: ENV, effort: "fast" });
    const max = resolveRouting({ cfg: cfg(), env: ENV, effort: "max" });

    assert.equal(fast.model, FAST_MODEL, "Fast must start on the small model");
    assert.equal(max.model, MAX_MODEL, "Max must start on the strong model");
    assert.equal(fast.effort, "fast");
    assert.equal(max.effort, "max");
    assert.equal(routingLabel(fast), `${FAST_MODEL} (fast)`);
    assert.equal(routingLabel(max), `${MAX_MODEL} (max)`);
  });

  it("a per-tool entry wins over the effort model", () => {
    const plan = resolveRouting({ cfg: cfg(), env: ENV, effort: "max", tool: "loam_studio" });
    assert.equal(plan.model, SLIDES_MODEL, "the specialist model serves its own tool");
    assert.equal(plan.tool, "loam_studio");
    assert.equal(plan.effort, "max", "effort still travels with the plan");
  });

  it("an unconfigured run is left untouched: no chain is forced on it", () => {
    const plan = resolveRouting({ cfg: cfg({ routing: { perTool: {}, effort: {} } }), env: ENV });
    assert.equal(plan.model, MAX_MODEL);
    // No map entry means "leave the run alone": the loop keeps using its own
    // client and model order instead of being re-pointed at a remote provider.
    assert.equal(plan.coding, false);
    assert.deepEqual(plan.providers, []);
    assert.equal(plan.tool, undefined);
    assert.equal(plan.effort, undefined);
  });

  it("an unknown effort never changes the model", () => {
    const plan = resolveRouting({ cfg: cfg(), env: ENV, effort: "" });
    assert.equal(plan.model, MAX_MODEL);
    assert.equal(plan.effort, undefined);
  });

  it("an output type is resolved even when it selects no model", () => {
    const plan = resolveRouting({ cfg: cfg(), env: ENV, outputType: "slides" });
    assert.equal(plan.outputType, "slides");
    assert.equal(isOutputType(plan.outputType), true);
  });

  it("an unusable effort model falls back to the coding chain", () => {
    // The model is configured but no enabled provider serves it, so the plan must
    // degrade to the chain rather than name a model nothing can serve.
    const plan = resolveRouting({
      cfg: cfg({ routing: { effort: { fast: "not-served-anywhere" } } }),
      env: ENV,
      effort: "fast",
    });
    assert.equal(plan.model, MAX_MODEL);
    assert.equal(plan.coding, true);
  });
});

describe("Neo N10 model map configuration", () => {
  it("reads config and lets the env overlay win", () => {
    const configMap = perToolModels(cfg(), ENV);
    assert.equal(configMap.loam_studio, SLIDES_MODEL);
    assert.equal(
      perToolModels(cfg(), { LOAM_ROUTING_PER_TOOL: "loam_canvas=image-model loam_studio=other" }).loam_studio,
      "other",
      "an env entry overrides the config entry",
    );
    assert.equal(perToolModels(cfg({ routing: undefined }), ENV).loam_studio, undefined);
  });

  it("parses the env map without inventing empty entries", () => {
    // A blank tool or model is dropped, and the env map is layered over config.
    const map = perToolModels(cfg(), { LOAM_ROUTING_PER_TOOL: "=nope  a=  b=model" });
    assert.deepEqual(map, { loam_studio: SLIDES_MODEL, b: "model" });
  });

  it("reads the effort map from config and env", () => {
    assert.deepEqual(effortModels(cfg(), ENV), { fast: FAST_MODEL, max: MAX_MODEL });
    assert.equal(effortModels(cfg(), { LOAM_ROUTING_FAST: "tiny" }).fast, "tiny");
    assert.equal(effortModels(cfg(), { LOAM_ROUTING_MAX: "huge" }).max, "huge");
    assert.equal(effortModels(cfg(), { LOAM_ROUTING_FAST: "   " }).fast, FAST_MODEL, "a blank env value is ignored");
  });

  it("providersForModels matches a configured model to its provider", () => {
    const matched = providersForModels(cfg(), [SLIDES_MODEL], ENV);
    assert.deepEqual(matched.map((p) => p.id), ["studio"]);
    assert.deepEqual(providersForModels(cfg(), ["unknown-model"], ENV), []);
  });
});

describe("Neo N10 multi-model A/B", () => {
  it("fans out to 3 distinct model arms", () => {
    // A per-tool route wins the round, so the plan's model is the specialist and
    // the effort model stays a distinct second arm.
    const three = cfg({
      routing: {
        effort: { fast: FAST_MODEL, max: MAX_MODEL },
        perTool: { loam_studio: SLIDES_MODEL, loam_canvas: "canvas-model" },
      },
      failover: {
        providers: [
          provider({ id: "local", model: FAST_MODEL }),
          provider({ id: "cloud", model: MAX_MODEL }),
          provider({ id: "studio", model: SLIDES_MODEL }),
          provider({ id: "canvas", model: "canvas-model" }),
        ],
      },
    });
    const arms = modelAbChain({ cfg: three, env: ENV, effort: "fast", tool: "loam_studio" }, 3);
    assert.equal(arms.length, 3, "three arms are requested and three are returned");
    assert.equal(new Set(arms).size, 3, "an arm is never repeated");
    assert.equal(arms[0], SLIDES_MODEL, "the run's own model leads the chain");
    assert.ok(arms.includes(FAST_MODEL), "the effort model joins the fan-out");
  });

  it("dedupes and clamps the arm count", () => {
    const many = cfg({
      routing: {
        effort: { fast: FAST_MODEL, max: MAX_MODEL },
        perTool: {
          loam_studio: SLIDES_MODEL, loam_canvas: "canvas-1", loam_creative: "creative-1",
          loam_document: "doc-1", office_export: "office-1",
        },
      },
    });
    const arms = modelAbChain({ cfg: many, env: ENV, effort: "max" }, 10);
    assert.equal(arms.length, 4, "at most four arms");
    assert.equal(new Set(arms).size, 4, "an arm is never repeated");
    assert.equal(modelAbChain({ cfg: many, env: ENV }, 1).length, 2, "a single arm is never enough for an A/B run");
  });

  it("returns nothing when no model is configured", () => {
    const arms = modelAbChain({ cfg: cfg({ routing: { perTool: {}, effort: {} } }), env: ENV }, 3);
    assert.deepEqual(arms, [MAX_MODEL], "the run's own model is the single arm");
  });
});
