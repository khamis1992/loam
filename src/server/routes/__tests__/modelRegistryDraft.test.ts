import assert from "node:assert/strict";
import { test } from "node:test";
import { RegistryZ } from "../../../models/registry/schema.js";
import { buildModelDraft, buildProviderDraft } from "../modelRegistry.js";

const OPENAI_ID = "11111111-1111-4111-8111-111111111111";
const ANTHROPIC_ID = "22222222-2222-4222-8222-222222222222";

test("a saved provider keeps a vault id and drops the raw key", async () => {
  const secret = "sk-test-REDACTED-0000";
  let stored = "";
  const provider = await buildProviderDraft([], {
    kind: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1/",
    apiKey: secret,
  }, async (value) => {
    stored = value;
    return { credentialId: OPENAI_ID };
  });
  assert.equal(stored, secret);
  assert.equal(provider.id, "openai");
  assert.equal(provider.kind, "openai-compatible");
  assert.equal(provider.auth.type, "bearer");
  assert.equal(provider.baseUrl, "https://api.openai.com/v1");
  assert.equal(JSON.stringify(provider).includes(secret), false);

  const model = buildModelDraft(provider, { remoteId: "gpt-4o" });
  assert.equal(model.id, "openai/gpt-4o");
  const registry = RegistryZ.parse({
    version: 1,
    providers: [provider],
    models: [model],
    chains: [{ id: "default", label: "Default", modelIds: [model.id] }],
    defaultModelId: model.id,
    fallbackModelId: null,
  });
  const saved = registry.models[0];
  assert.ok(saved);
  assert.equal(saved.id, "openai/gpt-4o");
});

test("anthropic and gemini keys use their header names", async () => {
  const anthropic = await buildProviderDraft([], {
    kind: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "sk-ant-test",
  }, async () => ({ credentialId: ANTHROPIC_ID }));
  assert.equal(anthropic.auth.type, "header");
  if (anthropic.auth.type === "header") assert.equal(anthropic.auth.header, "x-api-key");

  const gemini = await buildProviderDraft(["provider"], {
    kind: "gemini",
    label: "محلي",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "gem-test",
  }, async () => ({ credentialId: "33333333-3333-4333-8333-333333333333" }));
  assert.equal(gemini.id, "provider-2");
  assert.equal(gemini.kind, "google-gemini");
  if (gemini.auth.type === "header") assert.equal(gemini.auth.header, "x-goog-api-key");
});
