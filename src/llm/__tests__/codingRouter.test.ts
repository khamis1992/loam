import assert from "node:assert";
import { describe, it } from "node:test";
import type { Config } from "../../config.js";
import type { ChatOptions, ChatResult } from "../../ollama.js";
import {
  coderChainIds,
  chatWithCodingRouter,
  codingProviders,
  isCodingTurn,
  matchCoderProvider,
  parseCoderChain,
  selectCoder,
  usableProviders,
} from "../codingRouter.js";
import {
  providerKey,
  type CooldownEntry,
  type CooldownStore,
  type FailoverProvider,
  type ProviderClient,
} from "../failover.js";

function providers(overrides: Partial<FailoverProvider>[] = []): FailoverProvider[] {
  const base: FailoverProvider[] = [
    { id: "local", kind: "ollama", baseUrl: "http://local", model: "glm-5.3:cloud", apiKeyEnv: "", enabled: true },
    { id: "longcat", kind: "openai-compatible", baseUrl: "http://longcat/v1", model: "LongCat-2.5-Preview", apiKeyEnv: "LONGCAT_API_KEY", enabled: true },
    { id: "freellmapi", kind: "openai-compatible", baseUrl: "http://free/v1", model: "freellmapi/auto", apiKeyEnv: "FREELLM_API_KEY", enabled: true },
    { id: "keyless", kind: "openai-compatible", baseUrl: "http://keyless/v1", model: "keyless-model", apiKeyEnv: "MISSING_KEY", enabled: true },
  ];
  for (const override of overrides) {
    const index = base.findIndex((p) => p.id === override.id);
    if (index >= 0) base[index] = { ...base[index]!, ...override };
  }
  return base;
}

const ENV = { LONGCAT_API_KEY: "super-secret-longcat", FREELLM_API_KEY: "super-secret-free" };

function cfg(chain: string[] = [], list: FailoverProvider[] = providers()): Config {
  return { model: "glm-5.3-flash:cloud", coding: { enabled: true, chain, logEdits: true }, failover: { providers: list } } as unknown as Config;
}

class MemoryStore implements CooldownStore {
  private readonly map = new Map<string, CooldownEntry>();
  get(key: string): CooldownEntry | undefined {
    return this.map.get(key);
  }
  set(key: string, entry: CooldownEntry): void {
    this.map.set(key, entry);
  }
  entries(): Array<[string, CooldownEntry]> {
    return [...this.map.entries()];
  }
  save(): void {
    /* in-memory */
  }
}

const CHAT: ChatOptions = { model: "ignored", messages: [{ role: "user", content: "hi" }] };

function okResult(provider: string): ChatResult {
  return { content: `from ${provider}`, toolCalls: [], model: provider, usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
}

describe("coder chain resolution", () => {
  it("parses and dedupes a chain string", () => {
    assert.deepEqual(parseCoderChain(" a, b ,a  c "), ["a", "b", "c"]);
    assert.deepEqual(parseCoderChain(""), []);
    assert.deepEqual(parseCoderChain(undefined), []);
  });

  it("prefers the environment over the config file", () => {
    const result = coderChainIds(cfg(["config-model"]), { ...ENV, LOAM_CODER_CHAIN: "env-model" });
    assert.deepEqual(result.ids, ["env-model"]);
    assert.equal(result.source, "env");
  });

  it("uses the config chain when the environment is unset", () => {
    const result = coderChainIds(cfg(["strong-coder", "weak-coder"]), ENV);
    assert.deepEqual(result.ids, ["strong-coder", "weak-coder"]);
    assert.equal(result.source, "config");
  });

  it("falls back to the failover order when no chain is configured", () => {
    const result = coderChainIds(cfg([]), ENV);
    assert.deepEqual(result.ids, ["glm-5.3:cloud", "LongCat-2.5-Preview", "freellmapi/auto", "keyless-model"]);
    assert.equal(result.source, "failover");
  });
});

describe("coding provider selection", () => {
  it("orders providers by the chain, not the failover order", () => {
    const list = providers();
    const chain = ["freellmapi/auto", "LongCat-2.5-Preview"];
    const selected = codingProviders(cfg(chain, list), ENV);
    assert.deepEqual(selected.map((p) => p.id), ["freellmapi", "longcat"]);
  });

  it("matches a chain entry by provider id and by model substring", () => {
    const list = providers();
    assert.equal(matchCoderProvider("longcat", list)?.id, "longcat");
    assert.equal(matchCoderProvider("longcat-2.5-preview", list)?.id, "longcat");
    assert.equal(matchCoderProvider("nothing", list), undefined);
  });

  it("drops keyless cloud providers", () => {
    const selected = codingProviders(cfg(["keyless-model"]), ENV);
    assert.deepEqual(selected.map((p) => p.id), []);
    assert.deepEqual(usableProviders(cfg([], providers()), ENV).map((p) => p.id), ["local", "longcat", "freellmapi"]);
  });

  it("falls back to the whole chain when no chain entry matches", () => {
    const selected = codingProviders(cfg(["does-not-exist"]), ENV);
    assert.deepEqual(selected.map((p) => p.id), ["local", "longcat", "freellmapi"]);
  });

  it("selects the strongest coder and never exposes an API key", () => {
    const selection = selectCoder(cfg(["freellmapi/auto", "LongCat-2.5-Preview"]), ENV);
    assert.equal(selection.model, "freellmapi/auto");
    assert.equal(selection.provider?.id, "freellmapi");
    const serialized = JSON.stringify(selection);
    assert.ok(!serialized.includes("super-secret"), "selection must not leak key material");
    for (const key of Object.values(ENV)) assert.ok(!serialized.includes(key));
  });
});

describe("chatWithCodingRouter", () => {
  it("routes coding turns through the coding subset and reports the model", async () => {
    const calls: string[] = [];
    const routed: Array<{ model: string; chain: string[] }> = [];
    const store = new MemoryStore();
    const createClient = (provider: FailoverProvider): ProviderClient => ({
      async chat() {
        calls.push(provider.id);
        return okResult(provider.id);
      },
    });
    const fallback: ProviderClient = {
      async chat() {
        calls.push("fallback");
        return okResult("fallback");
      },
    };

    const result = await chatWithCodingRouter({
      cfg: cfg(["freellmapi/auto", "LongCat-2.5-Preview"]),
      chat: CHAT,
      fallback,
      env: ENV,
      store,
      createClient,
      onRoute: (info) => routed.push({ model: info.model, chain: info.chain }),
    });

    assert.equal(result.model, "freellmapi");
    assert.deepEqual(calls, ["freellmapi"]);
    assert.deepEqual(routed, [{ model: "freellmapi/auto", chain: ["freellmapi/auto", "LongCat-2.5-Preview"] }]);
    assert.ok(store.entries().length === 0, "a healthy first provider must not arm a cooldown");
  });

  it("fails over within the coding subset only", async () => {
    const calls: string[] = [];
    const store = new MemoryStore();
    const err = Object.assign(new Error("cloud HTTP 500"), { status: 500 });
    const createClient = (provider: FailoverProvider): ProviderClient => ({
      async chat() {
        calls.push(provider.id);
        if (provider.id === "freellmapi") throw err;
        return okResult(provider.id);
      },
    });

    const result = await chatWithCodingRouter({
      cfg: cfg(["freellmapi/auto", "LongCat-2.5-Preview"], providers([{ id: "local", enabled: false }])),
      chat: CHAT,
      fallback: { async chat() { calls.push("fallback"); return okResult("fallback"); } },
      env: ENV,
      store,
      createClient,
    });

    assert.equal(result.model, "longcat");
    assert.deepEqual(calls, ["freellmapi", "longcat"]);
    assert.ok(store.get(providerKey(providers()[2]!)), "the failed coding provider is cooled down");
  });

  it("uses the fallback client when no provider chain is configured", async () => {
    const calls: string[] = [];
    const result = await chatWithCodingRouter({
      cfg: cfg([], []),
      chat: CHAT,
      fallback: { async chat(opts) { calls.push(opts.model); return okResult(opts.model); } },
      env: ENV,
    });
    assert.equal(result.model, "glm-5.3-flash:cloud");
    assert.deepEqual(calls, ["glm-5.3-flash:cloud"]);
  });
});

describe("isCodingTurn", () => {
  it("detects coding requests and ignores plain chat", () => {
    assert.equal(isCodingTurn("Fix the bug in src/llm/failover.ts and add a test"), true);
    assert.equal(isCodingTurn("Refactor the router and run typecheck"), true);
    assert.equal(isCodingTurn("What is the capital of France?"), false);
  });
});
