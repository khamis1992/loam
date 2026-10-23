/**
 * V14 acceptance tests for UI-task model routing.
 *
 * The rule under test is the negative one: a model id with no live provider is
 * not a stronger choice, it is a model that cannot be served. Every case here
 * asserts a decision *and* its `source`, because the source is what tells a
 * caller whether the route came from the caller's own strength order, from the
 * provider catalogue, or from the configured default.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import { routeUiModel, type UiModelProvider, type UiRouteConfig } from "../route.js";

const NOW = 1_000_000;

function cfg(overrides: Partial<UiRouteConfig> = {}): UiRouteConfig {
  return { model: "configured", chain: [], providers: [], now: () => NOW, ...overrides };
}

function provider(id: string, model: string, overrides: Partial<UiModelProvider> = {}): UiModelProvider {
  return { id, model, enabled: true, ...overrides };
}

describe("routeUiModel: coding chain", () => {
  it("uses the first usable model in the coding chain", () => {
    const route = routeUiModel(
      cfg({
        chain: ["strong", "mid"],
        providers: [provider("p1", "mid"), provider("p2", "strong")],
      }),
    );
    assert.deepEqual(route, { model: "strong", provider: "p2", chain: ["p2"], source: "coding" });
  });

  it("skips a chain entry with no live provider", () => {
    // `ghost` is the strongest name in the chain but nothing can serve it, so
    // the route must fall through to the next usable entry.
    const route = routeUiModel(
      cfg({
        chain: ["ghost", "mid"],
        providers: [provider("p1", "mid")],
      }),
    );
    assert.equal(route.model, "mid");
    assert.equal(route.provider, "p1");
    assert.equal(route.source, "coding");
  });

  it("returns the configured model when the whole chain is unservable", () => {
    const route = routeUiModel(cfg({ chain: ["ghost"], providers: [] }));
    assert.equal(route.model, "configured");
    assert.equal(route.provider, "");
    assert.equal(route.source, "default");
  });

  it("lists every provider that can serve the chosen model, strongest first", () => {
    const route = routeUiModel(
      cfg({
        chain: ["strong"],
        providers: [provider("backup", "strong"), provider("primary", "strong")],
      }),
    );
    assert.equal(route.model, "strong");
    assert.deepEqual(route.chain, ["backup", "primary"]);
  });

  it("ignores a disabled provider even when the chain names its model", () => {
    const route = routeUiModel(
      cfg({
        chain: ["strong"],
        providers: [provider("p1", "strong", { enabled: false })],
      }),
    );
    assert.equal(route.source, "default");
    assert.equal(route.model, "configured");
  });

  it("ignores a provider without a credential", () => {
    const route = routeUiModel(
      cfg({
        chain: ["strong"],
        providers: [provider("p1", "strong", { hasKey: false })],
      }),
    );
    assert.equal(route.source, "default");
  });

  it("ignores a provider still in cooldown, and honours one that has recovered", () => {
    const cooling = routeUiModel(
      cfg({
        chain: ["strong"],
        providers: [provider("p1", "strong", { cooldownUntil: NOW + 60_000 })],
      }),
    );
    assert.equal(cooling.source, "default");

    const recovered = routeUiModel(
      cfg({
        chain: ["strong"],
        providers: [provider("p1", "strong", { cooldownUntil: NOW - 1 })],
      }),
    );
    assert.equal(recovered.model, "strong");
    assert.equal(recovered.source, "coding");
  });

  it("treats a blank chain entry as absent rather than as a model", () => {
    const route = routeUiModel(cfg({ chain: ["   ", "mid"], providers: [provider("p1", "mid")] }));
    assert.equal(route.model, "mid");
  });
});

describe("routeUiModel: strongest provider", () => {
  it("picks the strongest usable provider when the coding chain is empty", () => {
    const route = routeUiModel(
      cfg({
        providers: [provider("p1", "weak", { strength: 1 }), provider("p2", "strong", { strength: 9 })],
      }),
    );
    assert.equal(route.model, "strong");
    assert.equal(route.provider, "p2");
    assert.equal(route.source, "strongest");
  });

  it("prefers a provider that declares strength over one that does not", () => {
    const route = routeUiModel(
      cfg({
        providers: [provider("p1", "unknown"), provider("p2", "ranked", { strength: 0 })],
      }),
    );
    assert.equal(route.model, "ranked");
  });

  it("stays on the configured model when no provider is usable", () => {
    const route = routeUiModel(
      cfg({
        providers: [provider("p1", "strong", { enabled: false }), provider("p2", "mid", { hasKey: false })],
      }),
    );
    assert.deepEqual(route, { model: "configured", provider: "", chain: [], source: "default" });
  });

  it("ignores a provider that serves no model", () => {
    const route = routeUiModel(cfg({ providers: [provider("p1", "   ")] }));
    assert.equal(route.source, "default");
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
