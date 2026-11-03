import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { Config } from "../../src/config.js";
import { AnthropicAdapter } from "../../src/models/adapters/anthropic.js";
import { GeminiAdapter } from "../../src/models/adapters/gemini.js";
import { OpenAICompatAdapter } from "../../src/models/adapters/openaiCompat.js";
import { clearRegistryCache, setRegistryForTests } from "../../src/models/registry/init.js";
import { migrateFromConfig } from "../../src/models/registry/migrate.js";
import { deleteProviderCascade, reorderChain } from "../../src/models/registry/mutate.js";
import { compileChain } from "../../src/models/registry/compile.js";
import { resolveProviderApiKey } from "../../src/models/registry/registryClient.js";
import { buildModelDraft, buildProviderDraft } from "../../src/server/routes/modelRegistry.js";
import { anthropicToolStub, failingModelsStub, geminiToolStub, ollamaTagsStub } from "./stubs/servers.js";
import { loadRegistry, saveRegistry, setRegistryFileForTests } from "../../src/models/registry/store.js";
import type { ModelRegistry } from "../../src/models/registry/types.js";

const secret = "sk-test-REDACTED-0000";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-registry-e2e-"));
const registryPath = path.join(dir, "model-registry.json");
setRegistryFileForTests(registryPath);

function emptyRegistry(): ModelRegistry {
  return { version: 1, providers: [], models: [], chains: [{ id: "default", label: "Default", modelIds: [] }], defaultModelId: null, fallbackModelId: null };
}

after(() => {
  setRegistryFileForTests(null);
  setRegistryForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("E1 lists ollama tags and saves them on the default chain", async () => {
  const stub = await ollamaTagsStub();
  try {
    const names = await fetch(`${stub.url}/api/tags`).then((res) => res.json() as Promise<{ models: Array<{ name: string }> }>);
    const registry = emptyRegistry();
    const provider = await buildProviderDraft([], { kind: "ollama", label: "Ollama", baseUrl: stub.url }, async () => { throw new Error("no key"); });
    const model = buildModelDraft(provider, { remoteId: names.models[0].name });
    registry.providers.push(provider);
    registry.models.push(model);
    reorderChain(registry, "default", [model.id]);
    setRegistryForTests(registry);
    saveRegistry(registry);
    assert.equal(compileChain(registry)[0]?.model, "qwen-test:latest");
    assert.equal(fs.readFileSync(registryPath, "utf8").includes(secret), false);
  } finally {
    await stub.close();
  }
});

test("E2 stores a custom provider key outside the registry file", async () => {
  const registry = emptyRegistry();
  const provider = await buildProviderDraft(registry.providers.map((item) => item.id), {
    kind: "custom",
    label: "Local Studio",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: secret,
  }, async () => ({ credentialId: "44444444-4444-4444-8444-444444444444" }));
  const first = buildModelDraft(provider, { remoteId: "alpha" });
  const second = buildModelDraft(provider, { remoteId: "beta" });
  registry.providers.push(provider);
  registry.models.push(first, second);
  saveRegistry(registry);
  const saved = fs.readFileSync(registryPath, "utf8");
  assert.equal(saved.includes(secret), false);
  assert.match(saved, /44444444-4444-4444-8444-444444444444/);
  assert.equal(provider.auth.type, "bearer");
});

test("E3 a closed port surfaces an error and the provider can stay disabled", async () => {
  const adapter = new OpenAICompatAdapter({ baseUrl: "http://127.0.0.1:1/v1", timeoutMs: 500 });
  await assert.rejects(() => adapter.listModels());
  const provider = await buildProviderDraft([], { kind: "custom", label: "FreeLLM", baseUrl: "http://127.0.0.1:1/v1", enabled: false }, async () => { throw new Error("unused"); });
  assert.equal(provider.enabled, false);
});

test("E4 a model list that returns 500 still accepts a typed remote id", async () => {
  const stub = await failingModelsStub();
  try {
    const adapter = new OpenAICompatAdapter({ baseUrl: `${stub.url}/v1`, timeoutMs: 1000 });
    await assert.rejects(() => adapter.listModels());
    const provider = await buildProviderDraft([], { kind: "custom", label: "Manual", baseUrl: `${stub.url}/v1` }, async () => { throw new Error("unused"); });
    const model = buildModelDraft(provider, { remoteId: "typed-by-hand" });
    assert.equal(model.id, `${provider.id}/typed-by-hand`);
  } finally {
    await stub.close();
  }
});

test("E5 chain order is the failover order", async () => {
  const registry = emptyRegistry();
  const provider = await buildProviderDraft([], { kind: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434" }, async () => { throw new Error("unused"); });
  const first = buildModelDraft(provider, { remoteId: "one" });
  const second = buildModelDraft(provider, { remoteId: "two" });
  registry.providers.push(provider);
  registry.models.push(first, second);
  reorderChain(registry, "default", [second.id, first.id]);
  const chain = compileChain(registry);
  assert.deepEqual(chain.map((item) => item.model), ["two", "one"]);
});

test("E6 deleting a provider removes its models from the chain", async () => {
  const registry = emptyRegistry();
  const provider = await buildProviderDraft([], { kind: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: secret }, async () => ({ credentialId: "55555555-5555-4555-8555-555555555555" }));
  const model = buildModelDraft(provider, { remoteId: "gpt" });
  registry.providers.push(provider);
  registry.models.push(model);
  reorderChain(registry, "default", [model.id]);
  provider.auth = { type: "bearer", credentialId: "66666666-6666-4666-8666-666666666666" };
  deleteProviderCascade(registry, provider.id);
  assert.equal(registry.providers.length, 0);
  assert.deepEqual(registry.chains[0]?.modelIds, []);
  assert.equal(JSON.stringify(registry).includes(secret), false);
});

test("E7 anthropic and gemini stubs return a tool call", async () => {
  const anthropic = await anthropicToolStub(secret);
  const gemini = await geminiToolStub();
  try {
    const claude = new AnthropicAdapter({ baseUrl: anthropic.url, apiKey: secret, timeoutMs: 2000 });
    const claudeResult = await claude.chat({ model: "claude-test", messages: [{ role: "user", content: "go" }] });
    assert.equal(claudeResult.toolCalls[0]?.function.name, "lookup");
    const google = new GeminiAdapter({ baseUrl: gemini.url, apiKey: secret, timeoutMs: 2000, authHeader: "x-goog-api-key" });
    const googleResult = await google.chat({ model: "gemini-test", messages: [{ role: "user", content: "go" }] });
    assert.equal(googleResult.toolCalls[0]?.function.name, "lookup");
  } finally {
    await anthropic.close();
    await gemini.close();
  }
});

test("E8 migration keeps the cloud key out of the registry", async () => {
  let stored = "";
  const imported = await migrateFromConfig({
    config: {
      model: "gpt-test:cloud",
      fallbackModel: "gpt-test:cloud",
      ollamaUrl: "http://127.0.0.1:11434",
      cloudModel: { baseUrl: "https://example.test/v1", apiKey: secret },
      failover: { providers: [] },
      coding: { chain: [] },
      compression: { contextWindow: {} },
    } as Config,
    vault: { async put(value: string) { stored = value; return { credentialId: "77777777-7777-4777-8777-777777777777", hint: "...0000" }; }, async get() { return undefined; }, async hints() { return {}; }, async delete() { return true; } },
    fetchOllamaTags: async () => [],
    mode: "desktop",
  });
  assert.equal(stored, secret);
  assert.equal(JSON.stringify(imported).includes(secret), false);
  assert.equal(imported.defaultModelId, "cloud-legacy/gpt-test");
  assert.equal(imported.providers.find((provider) => provider.id === "cloud-legacy")?.auth.type, "bearer");
});

test("E9 the saved registry and the temp data dir do not contain the fake key", () => {
  const hits = fs.readdirSync(dir).filter((name) => fs.readFileSync(path.join(dir, name), "utf8").includes(secret));
  assert.deepEqual(hits, []);
});

test("saved default and fallback survive reloading the registry file", async () => {
  const registry = emptyRegistry();
  const provider = await buildProviderDraft([], { kind: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:9" }, async () => { throw new Error("no key"); });
  const model = buildModelDraft(provider, { remoteId: "persist" });
  registry.providers.push(provider);
  registry.models.push(model);
  registry.defaultModelId = model.id;
  registry.fallbackModelId = model.id;
  saveRegistry(registry);
  clearRegistryCache();
  setRegistryForTests(null);
  const loaded = loadRegistry();
  assert.equal(loaded?.defaultModelId, model.id);
  assert.equal(loaded?.fallbackModelId, model.id);
  assert.equal(JSON.stringify(loaded).includes(secret), false);
});

test("an environment-backed provider reads the key from the process and leaves it out of the record", async () => {
  const name = "LOAM_REGISTRY_TEST_KEY";
  process.env[name] = secret;
  try {
    const provider = await buildProviderDraft([], { kind: "custom", label: "Env", baseUrl: "https://example.test/v1", envVar: name }, async () => { throw new Error("no vault"); });
    assert.equal(provider.auth.type, "env");
    assert.equal(await resolveProviderApiKey(provider), secret);
    assert.equal(JSON.stringify(provider).includes(secret), false);
  } finally {
    delete process.env[name];
  }
});
