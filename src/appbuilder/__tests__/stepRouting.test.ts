// src/appbuilder/__tests__/stepRouting.test.ts — W3-a: §4.12.2 mapping, the
// cloud-only rule and the lite ban. Uses the same temp-data-dir pattern as
// g4.test.ts because resolveTierModel("standard"/"flex") reads settings/vault.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-stepr-"));
process.env.MANUS_LOCAL_DATA_DIR = tmp;
process.env.LOAM_TEST_CLOUD_KEY = "sk-steprouting-test-key";

import type { Config } from "../../config.js";
import type { FailoverProvider } from "../../llm/failover.js";
import type { AppProject } from "../types.js";
import { stepClass, AUTO_TIER, isCloudModel, modelForStep, NoCloudModelError } from "../stepRouting.js";

const CLOUD_MODEL = "glm-5.4-flash";
const LOCAL_MODEL = "qwen2.5:14b";

function provider(overrides: Partial<FailoverProvider> = {}): FailoverProvider {
  return {
    id: "ollama-local",
    kind: "ollama",
    baseUrl: "http://localhost:11434",
    model: LOCAL_MODEL,
    apiKeyEnv: "",
    enabled: true,
    ...overrides,
  };
}

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    model: CLOUD_MODEL,
    fallbackModel: LOCAL_MODEL,
    failover: {
      providers: [
        provider(),
        provider({ id: "cloud", kind: "openai-compatible", baseUrl: "https://api.example.com/v1", model: CLOUD_MODEL, apiKeyEnv: "LOAM_TEST_CLOUD_KEY" }),
      ],
    },
    vision: { enabled: true, maxImagesPerStep: 2 },
    ...overrides,
  } as Config;
}

function project(overrides: Partial<AppProject> = {}): AppProject {
  return {
    id: "app_testtesttest",
    taskId: "t1",
    title: "t",
    description: "",
    templateId: "web-app",
    features: [],
    workspaceDir: tmp,
    appDir: "app",
    defaultFlavor: "quick",
    status: "idle",
    activeVersion: null,
    settings: { defaultTier: "auto", raceBranches: 2, verifyTier: "standard", devServerPort: null },
    remixOfProjectId: null,
    remixOfVersion: null,
    depsMode: "shared",
    ai: { baseUrl: null, model: null, dailyTokenCap: null },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------- §4.12.2 mapping ----------

test("stepClass maps every step per spec", () => {
  assert.equal(stepClass("engineer", "visual-review"), "vision");
  assert.equal(stepClass("system", "version-title"), "fast");
  assert.equal(stepClass("system", "wiki"), "fast");
  assert.equal(stepClass("lead", "clarify"), "plan");
  assert.equal(stepClass("lead", "plan"), "plan");
  assert.equal(stepClass("engineer", "implement"), "code");
  assert.equal(stepClass("data", "role-work"), "code");
  assert.equal(stepClass("product", "role-work"), "plan");
  assert.equal(stepClass("architect", "role-work"), "plan");
  assert.equal(stepClass("seo", "role-work"), "plan");
  assert.equal(stepClass("system", "implement"), "plan");
});

test("AUTO_TIER never contains lite", () => {
  assert.deepEqual(AUTO_TIER, { plan: "max", code: "max", fast: "standard", vision: "max" });
  assert.ok(!Object.values(AUTO_TIER).includes("lite"));
});

// ---------- cloud-only rule ----------

test("isCloudModel: :cloud suffix, remote provider, local and unknown refusals", () => {
  const c = cfg();
  assert.equal(isCloudModel(c, ""), false);
  assert.equal(isCloudModel(c, "whatever:cloud"), true, "the :cloud suffix is always a cloud route");
  assert.equal(isCloudModel(c, CLOUD_MODEL), true, "keyed remote openai-compatible provider");
  assert.equal(isCloudModel(c, LOCAL_MODEL), false, "ollama kind never qualifies");
  assert.equal(isCloudModel(c, "unknown-model"), false, "no provider serves it");

  const localBase = cfg({ failover: { providers: [provider({ id: "vllm", kind: "openai-compatible", baseUrl: "http://127.0.0.1:8080/v1", model: "local-remote", apiKeyEnv: "LOAM_TEST_CLOUD_KEY" })] } });
  assert.equal(isCloudModel(localBase, "local-remote"), false, "localhost base URL is not cloud");

  const disabled = cfg({ failover: { providers: [provider({ id: "cloud", kind: "openai-compatible", baseUrl: "https://api.example.com/v1", model: CLOUD_MODEL, apiKeyEnv: "LOAM_TEST_CLOUD_KEY", enabled: false })] } });
  assert.equal(isCloudModel(disabled, CLOUD_MODEL), false, "disabled provider is not cloud");

  const keyless = cfg({ failover: { providers: [provider({ id: "cloud", kind: "openai-compatible", baseUrl: "https://api.example.com/v1", model: CLOUD_MODEL, apiKeyEnv: "NOPE_MISSING" })] } });
  assert.equal(isCloudModel(keyless, CLOUD_MODEL), false, "keyless cloud provider never serves the model");
});

// ---------- modelForStep ----------

test("modelForStep: auto picks the class tier and the cloud model", () => {
  const m = modelForStep(cfg(), project(), "engineer", "implement");
  assert.equal(m.class, "code");
  assert.equal(m.tier, "max");
  assert.equal(m.model, CLOUD_MODEL);
  assert.equal(m.flex, false);

  const fast = modelForStep(cfg(), project(), "system", "version-title");
  assert.equal(fast.class, "fast");
  assert.equal(fast.tier, "standard");
  assert.equal(fast.model, CLOUD_MODEL);

  const lead = modelForStep(cfg(), project(), "lead", "plan");
  assert.equal(lead.tier, "max");
});

test("modelForStep: a pinned tier is respected, lite is banned (local model rejected)", () => {
  // standard pinned: settings.model is empty on a fresh store, so standard
  // resolves to cfg.model (the cloud model) and is returned as-is.
  const pinned = modelForStep(cfg(), project({ settings: { defaultTier: "standard", raceBranches: 2, verifyTier: "standard", devServerPort: null } }), "engineer", "implement");
  assert.equal(pinned.tier, "standard");

  // lite pinned: lite resolves to cfg.fallbackModel (local ollama), fails the
  // cloud check, and the walk continues to max — the lite/local model is never used.
  const lite = modelForStep(cfg(), project({ settings: { defaultTier: "lite", raceBranches: 2, verifyTier: "standard", devServerPort: null } }), "engineer", "implement");
  assert.notEqual(lite.tier, "lite");
  assert.notEqual(lite.model, LOCAL_MODEL);
  assert.equal(lite.model, CLOUD_MODEL);
});

test("modelForStep: vision prefers cfg.vision.model when it is cloud", () => {
  const m = modelForStep(cfg({ vision: { enabled: true, maxImagesPerStep: 2, model: CLOUD_MODEL } }), project(), "engineer", "visual-review");
  assert.equal(m.class, "vision");
  assert.equal(m.model, CLOUD_MODEL);
  assert.equal(m.tier, "max");
});

test("modelForStep: throws NoCloudModelError when every tier resolves locally", () => {
  const allLocal = cfg({
    model: LOCAL_MODEL,
    fallbackModel: LOCAL_MODEL,
    failover: { providers: [provider()] },
  });
  assert.throws(() => modelForStep(allLocal, project(), "engineer", "implement"), NoCloudModelError);
  try {
    modelForStep(allLocal, project(), "lead", "plan");
    assert.fail("expected NoCloudModelError");
  } catch (err) {
    assert.ok(err instanceof NoCloudModelError);
    assert.match(err.message, /no_cloud_model/);
  }
});
