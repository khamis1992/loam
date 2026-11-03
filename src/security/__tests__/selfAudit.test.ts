import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSelfAudit } from "../selfAudit.js";
import { sastAdapter } from "../normalize/adapters/sast.js";
import { reconAdapter } from "../normalize/adapters/recon.js";
import { mcpAdapter } from "../normalize/adapters/mcp.js";
import { llmAdapter } from "../normalize/adapters/llm.js";
import { configAdapter } from "../normalize/adapters/config.js";
import type { RawFinding } from "../normalize/types.js";

describe("selfAudit", () => {
  it("fails on mastra and sparkles", () => {
    const r = runSelfAudit({
      packageJson: { engines: { node: ">=22.13.0" }, dependencies: { "@mastra/core": "1.0.0" } },
      sparklesInUi: true,
      protectedPathsRegistered: ["integration-grants"],
      untrustedToolNames: ["mcp__x"],
      asarAuditMode: "warn",
    });
    assert.equal(r.ok, false);
    assert.ok(r.failed.includes("self.no-mastra"));
    assert.ok(r.failed.includes("self.no-sparkles"));
  });
  it("passes a clean tree", () => {
    const r = runSelfAudit({
      packageJson: { engines: { node: ">=22.13.0" }, dependencies: {} },
      protectedPathsRegistered: ["foo/integration-grants"],
      untrustedToolNames: ["mcp__api"],
      asarAuditMode: "fail",
    });
    assert.equal(r.ok, true);
  });
});

describe("engine adapters", () => {
  const row = (engine: string): RawFinding => ({ engine: engine as RawFinding["engine"], ruleId: "x", severity: "low", target: "t", title: "ti", detail: "" });
  it("re-tags every engine and drops malformed rows", () => {
    const mixed = [row("sast"), { bad: true }, row("recon")];
    assert.deepEqual(sastAdapter.adapt(mixed).map((r) => r.engine), ["sast", "sast"]);
    assert.equal(reconAdapter.adapt([row("recon")])[0]!.engine, "recon");
    assert.equal(mcpAdapter.adapt([row("mcp")])[0]!.engine, "mcp");
    assert.equal(llmAdapter.adapt([row("llm")])[0]!.engine, "llm");
    assert.equal(configAdapter.adapt([row("config")])[0]!.engine, "config");
    assert.deepEqual(sastAdapter.adapt("not-array"), []);
  });
});
