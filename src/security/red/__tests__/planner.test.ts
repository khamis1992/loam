/**
 * Red planner tests (RED_TEAM_BUILD_SPEC §6.1 — model-driven planning graft).
 * The model only proposes; hallucinated/malformed proposals must be dropped and
 * a planner failure must never break the campaign.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { llmPlanner, normalizeProposal, rulePlanner } from "../orchestrator/planner.js";

const asset = { target: "http://127.0.0.1:3000/", status: 200, title: "Lab", techFingerprint: ["express"], webPaths: [] };
const caps = ["red.sqli", "red.templates"];

describe("llmPlanner", () => {
  it("parses a clean JSON reply into proposals", async () => {
    const planner = llmPlanner(async (prompt) => {
      assert.ok(prompt.includes("http://127.0.0.1:3000/"));
      assert.ok(prompt.includes("red.sqli"));
      return JSON.stringify([{ target: "http://127.0.0.1:3000/", claim: "SQLi in product search", rationale: "form present", capabilityHint: "red.sqli" }]);
    });
    const proposals = await planner("goal", [asset], caps);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]!.capabilityHint, "red.sqli");
    assert.equal(proposals[0]!.claim, "SQLi in product search");
  });

  it("accepts fenced JSON and drops malformed entries", async () => {
    const planner = llmPlanner(async () =>
      "```json\n[" +
      JSON.stringify({ target: "http://127.0.0.1:3000/", claim: "ok", capabilityHint: "red.templates" }) + "," +
      JSON.stringify({ target: "http://evil.example/", claim: "out of scope target" }) + "," +
      JSON.stringify({ target: "http://127.0.0.1:3000/" }) + "," +
      JSON.stringify({ target: "http://127.0.0.1:3000/", claim: "bad hint", capabilityHint: "red.nope" }) + "," +
      '"a string"' +
      "]\n```",
    );
    const proposals = await planner("g", [asset], caps);
    assert.equal(proposals.length, 1, "only the well-formed in-scope proposal survives");
    assert.equal(proposals[0]!.capabilityHint, "red.templates");
    assert.equal(proposals[0]!.claim, "ok");
  });

  it("a planner error degrades to an empty proposal list", async () => {
    const planner = llmPlanner(async () => {
      throw new Error("model down");
    });
    assert.deepEqual(await planner("g", [asset], caps), []);
  });

  it("no assets or no capabilities short-circuit", async () => {
    const planner = llmPlanner(async () => {
      throw new Error("must not call the model");
    });
    assert.deepEqual(await planner("g", [], caps), []);
    assert.deepEqual(await planner("g", [asset], []), []);
  });
});

describe("normalizeProposal", () => {
  it("rejects everything that is not an exact in-scope target with a claim and a valid hint", () => {
    const targets = new Set(["http://127.0.0.1:3000/"]);
    assert.equal(normalizeProposal(null, targets, caps), null);
    assert.equal(normalizeProposal({ target: "http://other/", claim: "x", capabilityHint: "red.sqli" }, targets, caps), null);
    assert.equal(normalizeProposal({ target: "http://127.0.0.1:3000/", capabilityHint: "red.sqli" }, targets, caps), null);
    assert.equal(normalizeProposal({ target: "http://127.0.0.1:3000/", claim: "no hint" }, targets, caps), null);
    assert.equal(normalizeProposal({ target: "http://127.0.0.1:3000/", claim: "bad hint", capabilityHint: "red.nope" }, targets, caps), null);
    const long = "x".repeat(301);
    assert.equal(normalizeProposal({ target: "http://127.0.0.1:3000/", claim: long, capabilityHint: "red.sqli" }, targets, caps), null);
    const ok = normalizeProposal({ target: "http://127.0.0.1:3000/", claim: "c", capabilityHint: "red.sqli" }, targets, caps);
    assert.equal(ok!.capabilityHint, "red.sqli");
  });
});

describe("rulePlanner", () => {
  it("proposes coverage per asset × capability deterministically", async () => {
    const proposals = await rulePlanner("g", [asset], caps);
    assert.equal(proposals.length, 2);
    assert.ok(proposals.every((p) => p.capabilityHint && p.target === asset.target));
  });
});
