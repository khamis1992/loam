import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { mergeUnifiedCoverage, summarizeUnifiedCoverage } from "../coverage/unified.js";
import { runHypothesisCampaign } from "../hypothesis.js";
import { SecurityPluginRegistry, signPlugin } from "../plugins.js";
import { groupByRootCause } from "../rootCause.js";
import { validateWithControls } from "../validators.js";

describe("unified coverage and hypotheses", () => {
  it("never reports clean with unknown or failed coverage", () => {
    const summary = summarizeUnifiedCoverage(mergeUnifiedCoverage([
      { surface: "web", target: "/account", control: "authorization", status: "covered", reason: "tested", evidenceIds: ["EV1"] },
      { surface: "mobile", target: "MASVS-AUTH-1", control: "MASVS-AUTH-1", status: "not-tested", reason: "device unavailable", evidenceIds: [] },
    ]));
    assert.equal(summary.clean, false);
    assert.equal(summary.unknown, 1);
  });

  it("ranks hypotheses and preserves unverified budget failures", async () => {
    const results = await runHypothesisCampaign([
      { id: "low", target: "/public", claim: "low", sensitivity: 8, provability: 9, requestCost: 1 },
      { id: "high", target: "/account", claim: "high", sensitivity: 10, provability: 8, requestCost: 1 },
      { id: "blocked", target: "/billing", claim: "blocked", sensitivity: 9, provability: 7, requestCost: 2 },
    ], async (item) => ({ status: "confirmed", observation: `proven ${item.id}`, evidenceIds: [`EV-${item.id}`] }), { maxRequests: 2 });
    assert.equal(results[0]?.id, "high");
    assert.equal(results[1]?.id, "low");
    assert.equal(results[2]?.status, "unverified");
  });

  it("requires both controls for confirmation", () => {
    assert.equal(validateWithControls({ matched: true, observation: "positive", evidenceIds: ["EV1"] }, { matched: true, observation: "negative", evidenceIds: ["EV2"] }).status, "confirmed");
    assert.equal(validateWithControls({ matched: true, observation: "positive", evidenceIds: ["EV1"] }, { matched: false, observation: "negative", evidenceIds: ["EV2"] }).status, "inconclusive");
  });
});

describe("root cause and signed plugins", () => {
  it("groups findings without dropping locations or evidence", () => {
    const groups = groupByRootCause([
      { ruleId: "bola", target: "/users/1", title: "A", component: "users", evidenceIds: ["EV1"] },
      { ruleId: "bola", target: "/users/2", title: "B", component: "users", evidenceIds: ["EV2"] },
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.findings.length, 2);
    assert.deepEqual(groups[0]?.evidenceIds, ["EV1", "EV2"]);
  });

  it("accepts signed manifests and rejects tampering and excess scope", () => {
    const key = randomBytes(32);
    const registry = new SecurityPluginRegistry(key, ["mobile"]);
    const manifest = signPlugin({ version: 1, id: "authorized-scenarios", publisher: "Loam", kind: "scenario-pack", scopes: ["mobile"], scenarios: [{ id: "scenario-1", controlId: "MASVS-AUTH-1", title: "Authorized test", method: "automated" }] }, key);
    registry.register(manifest);
    assert.equal(registry.list().length, 1);
    assert.throws(() => registry.get("missing"), /not registered/);
    assert.throws(() => registry.register({ ...manifest, id: "tampered", title: "changed" } as never), /signature mismatch|invalid plugin contract/);
    assert.throws(() => registry.register(signPlugin({ ...manifest, id: "excess", scopes: ["admin"] }, key)), /scope is not allowed/);
  });
});
