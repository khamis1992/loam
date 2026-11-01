/**
 * Dynamic session budget: the token ceiling scales with the run's model class
 * (local models' tokens are free; `:cloud` models are paid and fast), an
 * explicit config tokenLimit wins, and a manual raise freezes the user's
 * choice. applyModelDefaults only ever raises, never lowers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CLOUD_MODEL_TOKEN_LIMIT,
  DEFAULT_TOKEN_LIMIT,
  LOCAL_MODEL_TOKEN_LIMIT,
  SessionRuntime,
  isCloudModel,
} from "../sessionRuntime.js";

describe("isCloudModel", () => {
  it("classifies the :cloud marker (Ollama cloud catalog + failover providers)", () => {
    assert.equal(isCloudModel("glm-5.3:cloud"), true);
    assert.equal(isCloudModel("qwen3.5:397b-cloud"), false); // catalog suffix, not the routing marker
    assert.equal(isCloudModel("qwen36-uncensored-hauhau:latest"), false);
    assert.equal(isCloudModel(undefined), false);
    assert.equal(isCloudModel("  glm-5.3:cloud  "), true);
  });
});

describe("applyModelDefaults (dynamic token ceiling)", () => {
  it("raises a cloud session to the cloud ceiling", () => {
    const runtime = new SessionRuntime({ idleMinutes: 30 });
    const budget = runtime.applyModelDefaults("s-cloud", "glm-5.3:cloud");
    assert.equal(budget.tokenLimit, CLOUD_MODEL_TOKEN_LIMIT);
    runtime.close();
  });

  it("raises a local session to the (higher) local ceiling — tokens are free", () => {
    const runtime = new SessionRuntime({ idleMinutes: 30 });
    const budget = runtime.applyModelDefaults("s-local", "qwen36-uncensored-hauhau:latest");
    assert.equal(budget.tokenLimit, LOCAL_MODEL_TOKEN_LIMIT);
    assert.ok(LOCAL_MODEL_TOKEN_LIMIT > CLOUD_MODEL_TOKEN_LIMIT);
    runtime.close();
  });

  it("keeps the badge and the run on the same budget object", () => {
    const runtime = new SessionRuntime({ idleMinutes: 30 });
    runtime.applyModelDefaults("s-same", "glm-5.3:cloud");
    assert.equal(runtime.getBudget("s-same").tokenLimit, CLOUD_MODEL_TOKEN_LIMIT);
    runtime.close();
  });

  it("never lowers a ceiling the session already has", () => {
    const runtime = new SessionRuntime({ idleMinutes: 30, tokenLimit: 3_000_000 });
    const budget = runtime.applyModelDefaults("s-big", "glm-5.3:cloud");
    assert.equal(budget.tokenLimit, 3_000_000);
    runtime.close();
  });

  it("yields to an explicitly configured tokenLimit", () => {
    const runtime = new SessionRuntime({ idleMinutes: 30, tokenLimit: 777, tokenLimitConfigured: true });
    const budget = runtime.applyModelDefaults("s-cfg", "qwen36-uncensored-hauhau:latest");
    assert.equal(budget.tokenLimit, 777);
    runtime.close();
  });

  it("freezes the choice once the user raised manually", () => {
    const runtime = new SessionRuntime({ idleMinutes: 30 });
    runtime.applyModelDefaults("s-raised", "glm-5.3:cloud");
    runtime.raise("s-raised", { tokens: 100_000 });
    const raised = runtime.getBudget("s-raised");
    assert.equal(raised.raised, true);
    // A later, cheaper model class must not pull the ceiling back down.
    const after = runtime.applyModelDefaults("s-raised", "qwen36-uncensored-hauhau:latest");
    assert.equal(after, raised);
    assert.equal(after.tokenLimit, CLOUD_MODEL_TOKEN_LIMIT + 100_000);
    runtime.close();
  });

  it("a session that only hit the floor keeps scaling on its next run", () => {
    const runtime = new SessionRuntime({ idleMinutes: 30 });
    const first = runtime.applyModelDefaults("s-switch", "glm-5.3:cloud");
    assert.equal(first.tokenLimit, CLOUD_MODEL_TOKEN_LIMIT);
    // Model switch mid-session without a manual raise: take the larger class.
    const second = runtime.applyModelDefaults("s-switch", "qwen36-uncensored-hauhau:latest");
    assert.equal(second.tokenLimit, LOCAL_MODEL_TOKEN_LIMIT);
    runtime.close();
  });

  it("the shipped default stays the floor for unconfigured sessions", () => {
    const runtime = new SessionRuntime({ idleMinutes: 30 });
    assert.equal(runtime.getBudget("s-floor").tokenLimit ?? DEFAULT_TOKEN_LIMIT, DEFAULT_TOKEN_LIMIT);
    runtime.close();
  });
});
