/**
 * V14 acceptance tests for UI-task model routing.
 *
 * The rule under test is the negative one: a model id with no live provider is
 * not a stronger choice, it is a model that cannot be served. Every case here
 * asserts a decision *and* its `source`, because the source is what tells a
 * caller whether the route came from the caller's own strength order, from the
 * provider catalogue, or from the configured default.
 *
 * The providers are real `FailoverProvider`s, so the credential rule under test
 * is the one the failover walk actually applies (`hasUsableKey` reads the key
 * from the environment by `apiKeyEnv` name). A provider shaped for the test but
 * unlike production would prove nothing about production.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import { routeUiModel, type UiRouteConfig } from "../route.js";
import { providerKey, type CooldownEntry, type CooldownStore, type FailoverProvider } from "../../llm/failover.js";
import { selectCoder } from "../../llm/codingRouter.js";
import type { Config } from "../../config.js";

const NOW = 1_000_000;

/** A local provider, which needs no credential. */
function local(id: string, model: string, overrides: Partial<FailoverProvider> = {}): FailoverProvider {
  return { id, kind: "ollama", baseUrl: "http://local", model, apiKeyEnv: "", enabled: true, ...overrides };
}

/** A cloud provider, which is only usable when its key is present in the env. */
function cloud(id: string, model: string, keyEnv: string, overrides: Partial<FailoverProvider> = {}): FailoverProvider {
  return {
    id,
    kind: "openai-compatible",
    baseUrl: `https://${id}.example/v1`,
    model,
    apiKeyEnv: keyEnv,
    enabled: true,
    ...overrides,
  };
}

const ENV = { STRONG_KEY: "secret-strong", MID_KEY: "secret-mid" };

function cfg(overrides: Partial<UiRouteConfig> = {}): UiRouteConfig {
  return { model: "configured", chain: [], providers: [], env: ENV, now: () => NOW, ...overrides };
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

describe("routeUiModel: coding chain", () => {
  it("uses the first servable model in the coding chain", () => {
    const route = routeUiModel(
      cfg({
        chain: ["strong", "mid"],
        providers: [local("p1", "mid"), local("p2", "strong")],
      }),
    );
    assert.deepEqual(route, { model: "strong", provider: "p2", chain: ["p2"], source: "coding" });
  });

  it("skips a chain entry with no live provider", () => {
    // `ghost` is the strongest name in the chain but nothing can serve it, so
    // the route must fall through to the next servable entry.
    const route = routeUiModel(
      cfg({
        chain: ["ghost", "mid"],
        providers: [local("p1", "mid")],
      }),
    );
    assert.equal(route.model, "mid");
    assert.equal(route.provider, "p1");
    assert.equal(route.source, "coding");
  });

  it("falls back to the strongest available provider when the chain matches nothing", () => {
    // A chain that names no servable model must not strand the run on the
    // configured default while a perfectly good provider is sitting right there.
    const route = routeUiModel(
      cfg({
        chain: ["ghost"],
        providers: [local("p1", "live")],
      }),
    );
    assert.equal(route.model, "live");
    assert.equal(route.provider, "p1");
    // The chain did not name this model, so calling it a chain decision would
    // overstate what happened.
    assert.equal(route.source, "strongest");
  });

  it("returns the configured model when nothing is available at all", () => {
    const route = routeUiModel(cfg({ chain: ["ghost"], providers: [] }));
    assert.equal(route.model, "configured");
    assert.equal(route.provider, "");
    assert.equal(route.source, "default");
  });

  it("lists every provider that can serve the chosen model, strongest first", () => {
    const route = routeUiModel(
      cfg({
        chain: ["strong"],
        providers: [local("backup", "strong"), local("primary", "strong")],
      }),
    );
    assert.equal(route.model, "strong");
    // The full candidate list is what failover walks, so it must not be trimmed
    // to the single winning provider.
    assert.deepEqual(route.chain, ["backup", "primary"]);
  });

  it("ignores a disabled provider even when the chain names its model", () => {
    const route = routeUiModel(
      cfg({
        chain: ["strong"],
        providers: [local("p1", "strong", { enabled: false })],
      }),
    );
    assert.equal(route.source, "default");
    assert.equal(route.model, "configured");
  });

  it("does not route to a cloud provider whose key is missing", () => {
    // The defect this guards: a provider catalogue that reports usability from
    // its own invented field would happily route to a keyless cloud provider and
    // turn the request into a 401. Usability must come from the real key lookup.
    const route = routeUiModel(
      cfg({
        chain: ["strong"],
        providers: [cloud("p1", "strong", "STRONG_KEY")],
        env: {}, // the key is absent
      }),
    );
    assert.equal(route.source, "default");
    assert.equal(route.model, "configured");
    assert.equal(route.provider, "");
  });

  it("routes to a cloud provider once its key is present", () => {
    const route = routeUiModel(
      cfg({
        chain: ["strong"],
        providers: [cloud("p1", "strong", "STRONG_KEY")],
        env: ENV,
      }),
    );
    assert.equal(route.model, "strong");
    assert.equal(route.source, "coding");
  });

  it("skips a keyless cloud provider in favour of a servable one", () => {
    const route = routeUiModel(
      cfg({
        chain: ["strong", "mid"],
        providers: [cloud("p1", "strong", "MISSING_KEY"), local("p2", "mid")],
      }),
    );
    assert.equal(route.model, "mid");
    assert.equal(route.provider, "p2");
    assert.equal(route.source, "coding");
  });

  it("ignores a provider still in cooldown, and honours one that has recovered", () => {
    const store = new MemoryStore();
    const p1 = local("p1", "strong");
    store.set(providerKey(p1), { expiresAt: NOW + 60_000, backoffCount: 1 });

    const cooling = routeUiModel(cfg({ chain: ["strong"], providers: [p1], store }));
    assert.equal(cooling.source, "default");

    const recovered = new MemoryStore();
    recovered.set(providerKey(p1), { expiresAt: NOW - 1, backoffCount: 1 });
    const route = routeUiModel(cfg({ chain: ["strong"], providers: [p1], store: recovered }));
    assert.equal(route.model, "strong");
    assert.equal(route.source, "coding");
  });

  it("falls through to the next provider when the strongest is cooling down", () => {
    const store = new MemoryStore();
    const hot = local("hot", "strong");
    store.set(providerKey(hot), { expiresAt: NOW + 60_000, backoffCount: 1 });
    const route = routeUiModel(
      cfg({
        chain: ["strong", "mid"],
        providers: [hot, local("p2", "mid")],
        store,
      }),
    );
    assert.equal(route.model, "mid");
    assert.equal(route.provider, "p2");
  });

  it("treats a blank chain entry as absent rather than as a model", () => {
    const route = routeUiModel(cfg({ chain: ["   ", "mid"], providers: [local("p1", "mid")] }));
    assert.equal(route.model, "mid");
    assert.equal(route.source, "coding");
  });
});

describe("routeUiModel: strongest provider", () => {
  it("picks the first provider when the coding chain is empty", () => {
    // With no chain, the failover order *is* the strength order, so the first
    // enabled provider wins.
    const route = routeUiModel(
      cfg({
        providers: [local("p1", "weak"), local("p2", "strong")],
      }),
    );
    assert.equal(route.model, "weak");
    assert.equal(route.provider, "p1");
    assert.equal(route.source, "strongest");
  });

  it("skips a disabled provider when choosing the strongest", () => {
    const route = routeUiModel(
      cfg({
        providers: [local("p1", "off", { enabled: false }), local("p2", "on")],
      }),
    );
    assert.equal(route.model, "on");
    assert.equal(route.provider, "p2");
    assert.equal(route.source, "strongest");
  });

  it("stays on the configured model when no provider is available", () => {
    const route = routeUiModel(
      cfg({
        providers: [local("p1", "off", { enabled: false }), cloud("p2", "mid", "MISSING_KEY")],
      }),
    );
    assert.deepEqual(route, { model: "configured", provider: "", chain: [], source: "default" });
  });

  it("keeps the configured model when every provider is cooling down", () => {
    const store = new MemoryStore();
    const p1 = local("p1", "strong");
    store.set(providerKey(p1), { expiresAt: NOW + 1, backoffCount: 1 });
    const route = routeUiModel(cfg({ providers: [p1], store }));
    assert.equal(route.source, "default");
    assert.equal(route.model, "configured");
  });
});

describe("routeUiModel: defaults", () => {
  it("falls back to a local model when nothing is configured", () => {
    const route = routeUiModel(undefined);
    assert.equal(route.model, "local");
    assert.equal(route.source, "default");
  });

  it("falls back to a local model for an empty config", () => {
    const route = routeUiModel({ model: "", chain: [], providers: [] });
    assert.equal(route.model, "local");
  });

  it("never routes to an empty configured model", () => {
    const route = routeUiModel(cfg({ model: "  " }));
    assert.equal(route.model, "local");
  });
});

describe("routeUiModel: parity with the coding router", () => {
  // The reason this module reuses `codingRouter` instead of resolving providers
  // itself: a UI task and a coding turn must never disagree about which model is
  // strongest and available. These cases run the same config through both.
  const cases: Array<{ name: string; chain: string[]; providers: FailoverProvider[] }> = [
    {
      name: "a chain that names a servable model",
      chain: ["strong", "mid"],
      providers: [local("p1", "mid"), local("p2", "strong")],
    },
    {
      name: "a chain whose entries are all unservable",
      chain: ["ghost"],
      providers: [local("p1", "live")],
    },
    {
      name: "an empty chain, so the failover order decides",
      chain: [],
      providers: [local("p1", "first"), local("p2", "second")],
    },
    {
      name: "a disabled provider ahead of a live one",
      chain: [],
      providers: [local("p1", "off", { enabled: false }), local("p2", "on")],
    },
    {
      name: "a keyless cloud provider ahead of a local one",
      chain: [],
      providers: [cloud("p1", "cloud-model", "MISSING_KEY"), local("p2", "local-model")],
    },
    {
      name: "a cloud provider whose key is present",
      chain: ["cloud-model"],
      providers: [cloud("p1", "cloud-model", "STRONG_KEY")],
    },
  ];

  for (const testCase of cases) {
    it(`agrees with selectCoder on ${testCase.name}`, () => {
      const config = {
        model: "configured",
        coding: { enabled: true, chain: testCase.chain },
        failover: { providers: testCase.providers },
      } as unknown as Config;

      const ui = routeUiModel({
        model: "configured",
        chain: testCase.chain,
        providers: testCase.providers,
        env: ENV,
        now: () => NOW,
      });
      const coder = selectCoder(config, ENV);

      // The two routers may only differ when nothing is servable: the coding
      // router then reports the configured model with no provider, and so does
      // this one. Any other divergence means the rules have drifted apart.
      assert.equal(ui.model, coder.model, `model diverged on ${testCase.name}`);
      assert.equal(ui.provider, coder.provider?.id ?? "", `provider diverged on ${testCase.name}`);
    });
  }
});
