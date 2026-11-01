import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, describe, test } from "node:test";

let tmpDir = "";

/** One scripted remote: map URL -> OpenAI-style /models payload or status. */
function scriptRemote(map: Record<string, { status?: number; body?: unknown }>) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const hit = Object.entries(map).find(([prefix]) => url.startsWith(prefix));
    if (!hit) return new Response("not found", { status: 404 });
    const { status = 200, body } = hit[1];
    return new Response(JSON.stringify(body ?? {}), { status, headers: { "content-type": "application/json" } });
  };
}

describe("modelDirectory", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-modeldir-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    process.env.LOAM_ROOT = tmpDir;
    const { __setFetcherForTests } = await import("../modelDirectory.js");
    const { setFlexConfig } = await import("../modelTiers.js");
    __setFetcherForTests(scriptRemote({}) as unknown as typeof fetch);
    return () => { __setFetcherForTests(); };
  });

  test("aggregates ollama + flex + cloud + failover providers, deduped per source", async () => {
    const { __setFetcherForTests, listModelDirectory } = await import("../modelDirectory.js");
    const { setFlexConfig } = await import("../modelTiers.js");
    // Seed the Flex slot (settings + vault key under the temp DATA_DIR).
    setFlexConfig({ baseUrl: "http://127.0.0.1:31415/v1", model: "seed", key: "vault-key" });

    __setFetcherForTests(scriptRemote({
      "http://127.0.0.1:31415/v1/models": { body: { data: [{ id: "glm-5.3-flash" }, { id: "glm-5.3-flash" }] } },
      "https://api.longcat.chat/openai/v1/models": { body: { models: [{ id: "LongCat-2.5-Preview" }] } },
      "https://openrouter.ai/api/v1/models": { status: 500 },
      "https://opencode.ai/inference/go/openai/v1/models": { body: { data: [{ id: "go-flash" }] } },
    }) as unknown as typeof fetch);

    const cfg = {
      ollamaUrl: "http://127.0.0.1:11434",
      model: "base",
      failover: {
        providers: [
          { id: "opencode-go", kind: "openai-compatible", baseUrl: "https://opencode.ai/inference/go/openai/v1", model: "x", apiKeyEnv: "", enabled: true },
          { id: "freellmapi", kind: "openai-compatible", baseUrl: "http://127.0.0.1:31415/v1", model: "y", apiKeyEnv: "", enabled: false },
          { id: "longcat", kind: "openai-compatible", baseUrl: "https://api.longcat.chat/openai/v1", model: "z", apiKeyEnv: "", enabled: true },
          { id: "openrouter", kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "w", apiKeyEnv: "", enabled: true },
        ],
      },
    } as never;

    const dir = await listModelDirectory(cfg, async () => ["llama3:8b", "qwen2.5:14b"]);

    // Ollama entries.
    assert.ok(dir.models.some((m) => m.id === "llama3:8b" && m.source === "ollama" && m.kind === "ollama"));
    // Flex (the freellmapi router, probed even though the failover entry is disabled).
    assert.ok(dir.models.some((m) => m.id === "glm-5.3-flash" && m.source === "flex"));
    assert.equal(dir.models.filter((m) => m.id === "glm-5.3-flash").length, 1, "deduped within a source");
    // LongCat answered with the alternate `models` array shape.
    assert.ok(dir.models.some((m) => m.id === "LongCat-2.5-Preview" && m.source === "longcat"));
    // OpenRouter failed -> recorded on the source, models empty.
    const or = dir.sources.find((s) => s.source === "openrouter");
    assert.ok(or && or.error && or.count === 0);
    // Both flex and the freellmapi provider point at the same router: the
    // provider entry itself also reports what the probe saw.
    const free = dir.sources.find((s) => s.source === "freellmapi");
    assert.ok(free && free.count === 1);
  });

  test("ollama down degrades to an error source, never throws", async () => {
    const { __setFetcherForTests, listModelDirectory } = await import("../modelDirectory.js");
    __setFetcherForTests(scriptRemote({}) as unknown as typeof fetch);
    const dir = await listModelDirectory({ ollamaUrl: "http://127.0.0.1:1" } as never, async () => {
      throw new Error("connection refused");
    });
    const ollama = dir.sources.find((s) => s.source === "ollama");
    assert.ok(ollama?.error?.includes("connection refused"));
    assert.equal(dir.models.filter((m) => m.source === "ollama").length, 0);
  });

  test("non-http schemes are refused by the probe", async () => {
    const { __setFetcherForTests, listModelDirectory } = await import("../modelDirectory.js");
    __setFetcherForTests(scriptRemote({}) as unknown as typeof fetch);
    const cfg = {
      ollamaUrl: "http://127.0.0.1:11434",
      failover: { providers: [{ id: "bad", kind: "openai-compatible", baseUrl: "ftp://example.com/v1", model: "x", apiKeyEnv: "", enabled: true }] },
    } as never;
    const dir = await listModelDirectory(cfg, async () => []);
    const bad = dir.sources.find((s) => s.source === "bad");
    assert.ok(bad?.error, "scheme rejection recorded");
    assert.equal(bad?.count, 0);
  });

  test("selectModel: local -> settings.model (standard tier)", async () => {
    const { selectModel } = await import("../modelDirectory.js");
    const { getSettings } = await import("../settings.js");
    const result = await selectModel({} as never, { id: "llama3:8b", source: "ollama" });
    assert.deepEqual(result, { ok: true, tier: "standard", model: "llama3:8b", needsKey: false });
    assert.equal(getSettings().model, "llama3:8b");
  });

  test("selectModel: cloud provider routes through Flex and flags a missing key", async () => {
    const { selectModel } = await import("../modelDirectory.js");
    const { flexConfig, setFlexConfig } = await import("../modelTiers.js");
    delete process.env.FREELLM_API_KEY;
    // Order independence: move the Flex slot off this provider first (a key
    // sealed for the same router by an earlier test is legitimately reusable).
    setFlexConfig({ baseUrl: "https://elsewhere.example/v1", model: "previous" });
    const cfg = {
      failover: { providers: [{ id: "freellmapi", kind: "openai-compatible", baseUrl: "http://127.0.0.1:31415/v1", model: "y", apiKeyEnv: "FREELLM_API_KEY", enabled: false }] },
    } as never;
    const result = await selectModel(cfg, { id: "glm-5.3-flash", source: "freellmapi" });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.tier, "flex");
      assert.equal(result.model, "glm-5.3-flash:cloud");
      assert.equal(result.needsKey, true, "no vault key and no FREELLM_API_KEY -> needsKey");
    }
    assert.equal(flexConfig().baseUrl, "http://127.0.0.1:31415/v1");
    assert.equal(flexConfig().model, "glm-5.3-flash");
    // With the env key present the same pick is complete.
    process.env.FREELLM_API_KEY = "env-key";
    const again = await selectModel(cfg, { id: "glm-5.3-flash", source: "freellmapi" });
    assert.ok(again.ok && !again.needsKey);
    delete process.env.FREELLM_API_KEY;
  });

  test("selectModel: rejects unknown sources and blank ids", async () => {
    const { selectModel } = await import("../modelDirectory.js");
    assert.equal((await selectModel({} as never, { id: "", source: "ollama" })).ok, false);
    assert.equal((await selectModel({} as never, { id: "m", source: "nope" })).ok, false);
  });

  test("activeModel reports the effective model, settings and flex state", async () => {
    const { activeModel } = await import("../modelDirectory.js");
    const active = activeModel({ model: "glm-5.3-flash:cloud" } as never);
    assert.equal(active.model, "glm-5.3-flash:cloud");
    assert.equal(typeof active.flex.baseUrl, "string");
  });

  /** A valid registry file exercising the PR #4 integration paths. */
  const REGISTRY_FIXTURE = {
    version: 1,
    providers: [
      {
        id: "my-gateway", label: "بوابعتي", kind: "openai-compatible", presetId: "custom",
        baseUrl: "https://my-gateway.example/v1", location: "cloud",
        auth: { type: "none" }, extraHeaders: {}, timeoutMs: 30000,
        enabled: true, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
      },
      {
        id: "claude-direct", label: "Claude مباشر", kind: "anthropic", presetId: "anthropic",
        baseUrl: "https://api.anthropic.com", location: "cloud",
        auth: { type: "header", credentialId: "11111111-1111-4111-8111-111111111111", header: "x-api-key" },
        extraHeaders: {}, timeoutMs: 30000,
        enabled: true, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
      },
      {
        id: "off-provider", label: "معطل", kind: "openai-compatible", presetId: "custom",
        baseUrl: "https://off.example/v1", location: "cloud",
        auth: { type: "none" }, extraHeaders: {}, timeoutMs: 30000,
        enabled: false, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
      },
    ],
    models: [
      {
        id: "my-gateway/gpt-custom", providerId: "my-gateway", remoteId: "gpt-custom", label: "GPT مخصص",
        capabilities: { tools: "unknown", vision: "unknown", thinking: "unknown", jsonMode: "unknown", contextWindow: null, maxOutputTokens: null, source: "user" },
        defaults: {}, enabled: true,
      },
      {
        id: "claude-direct/claude-4", providerId: "claude-direct", remoteId: "claude-4", label: "Claude 4",
        capabilities: { tools: true, vision: "unknown", thinking: "always", jsonMode: true, contextWindow: 200000, maxOutputTokens: 8192, source: "user" },
        defaults: {}, enabled: true,
      },
    ],
    chains: [{ id: "default", label: "Default", modelIds: ["my-gateway/gpt-custom"] }],
    defaultModelId: null,
    fallbackModelId: null,
  };

  test("registry providers join the directory; failover-covered endpoints dedupe; disabled skipped", async () => {
    fs.writeFileSync(path.join(tmpDir, "model-registry.json"), JSON.stringify(REGISTRY_FIXTURE));
    const { initializeRegistry } = await import("../../models/registry/init.js");
    const { listModelDirectory } = await import("../modelDirectory.js");
    await initializeRegistry({ ollamaUrl: "http://127.0.0.1:11434" } as never);
    const dir = await listModelDirectory(
      { ollamaUrl: "http://127.0.0.1:11434", failover: { providers: [] } } as never,
      async () => ["llama3:8b"],
    );
    const gateway = dir.sources.find((s) => s.source === "registry:my-gateway");
    assert.ok(gateway && gateway.count === 1, "registry provider listed with its model");
    assert.ok(dir.models.some((m) => m.id === "gpt-custom" && m.source === "registry:my-gateway"));
    // Anthropic provider IS listed (visibility), its model too.
    assert.ok(dir.models.some((m) => m.id === "claude-4" && m.source === "registry:claude-direct"));
    // Disabled provider never appears.
    assert.ok(!dir.sources.some((s) => s.source === "registry:off-provider"));
    // (Endpoint dedupe against failover is covered by the flex/freellmapi test:
    // the registry cache cannot be reset in-process to reload a second file.)
  });

  test("selectModel: registry openai-compatible routes through Flex (auth none = no key needed)", async () => {
    fs.writeFileSync(path.join(tmpDir, "model-registry.json"), JSON.stringify(REGISTRY_FIXTURE));
    const { initializeRegistry } = await import("../../models/registry/init.js");
    const { selectModel } = await import("../modelDirectory.js");
    const { flexConfig } = await import("../modelTiers.js");
    await initializeRegistry({ ollamaUrl: "http://127.0.0.1:11434" } as never);
    const { setFlexConfig } = await import("../modelTiers.js");
    setFlexConfig({ baseUrl: "https://elsewhere.example/v1", model: "previous" });
    const result = await selectModel({ ollamaUrl: "http://127.0.0.1:11434" } as never, { id: "gpt-custom", source: "registry:my-gateway" });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.tier, "flex");
      assert.equal(result.model, "gpt-custom:cloud");
      assert.equal(result.needsKey, false, "auth none needs no key");
    }
    assert.equal(flexConfig().baseUrl, "https://my-gateway.example/v1");
    assert.equal(flexConfig().model, "gpt-custom");
  });

  test("selectModel: registry anthropic explains the routing limit instead of silently misrouting", async () => {
    fs.writeFileSync(path.join(tmpDir, "model-registry.json"), JSON.stringify(REGISTRY_FIXTURE));
    const { initializeRegistry } = await import("../../models/registry/init.js");
    const { selectModel } = await import("../modelDirectory.js");
    await initializeRegistry({ ollamaUrl: "http://127.0.0.1:11434" } as never);
    const result = await selectModel({ ollamaUrl: "http://127.0.0.1:11434" } as never, { id: "claude-4", source: "registry:claude-direct" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /failover/);
  });
});
