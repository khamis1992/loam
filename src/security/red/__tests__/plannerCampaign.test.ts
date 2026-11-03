/**
 * runCampaign + planner integration tests: model proposals flow through the
 * capability validation and the evidence gate exactly like rule-based hunts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { describe, it } from "node:test";

import type { BridgeEnvelope } from "../../../bridges/types.js";
import type { Evidence } from "../../orchestrator.js";
import { runCampaign, type RedCapability, type RedCapabilityContext, RedHypothesis, RedValidation } from "../orchestrator/redOrchestrator.js";

const noBridge = async (): Promise<BridgeEnvelope> => ({ ok: false, exitCode: null, timedOut: false, error: { type: "x", message: "x" } });
const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "loam-red-planner-"));

const startLab = async (): Promise<{ server: http.Server; url: string }> => {
  const server = http.createServer((_req, res) => res.end("<html><title>Lab</title></html>"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}` };
};

describe("runCampaign with a planner", () => {
  it("a confirmed model proposal becomes a finding; a hallucinated one lands in unverified", async () => {
    const lab = await startLab();
    try {
      const validated: string[] = [];
      const cap: RedCapability = {
        id: "red.probe",
        applicable: () => true,
        hunt: async (target): Promise<RedHypothesis[]> => [{ id: "HYP-HUNT-1", capability: "red.probe", target, claim: "rule-based claim" }],
        validate: async (hyp): Promise<RedValidation> => {
          validated.push(hyp.id);
          const proven = hyp.id.startsWith("HYP-PLAN");
          const evidence: Evidence[] = proven
            ? [{ id: "EV7001", kind: "poc", at: new Date().toISOString(), poc: `GET ${hyp.target}`, observed: "confirmed by probe" }]
            : [];
          return {
            hypothesisId: hyp.id,
            status: proven ? "confirmed" : "refuted",
            claim: hyp.claim,
            detail: proven ? "confirmed by probe" : "not reproduced",
            evidence,
            ...(proven
              ? { finding: { check: "red_probe", verdict: "finding" as const, severity: "high", title: hyp.claim, target: hyp.target, detail: "confirmed by probe" } }
              : {}),
          };
        },
      };
      const result = await runCampaign(
        { goal: "g", authzId: null, targets: [lab.url] },
        {
          dataRoot: tempRoot(),
          bridge: noBridge,
          capabilities: [cap],
          planner: async (_goal, assets, ids) => [
            { target: assets[0]!.target, claim: "model-proposed weakness", rationale: "fingerprint", capabilityHint: ids[0] },
          ],
        },
      );
      // The planner proposal (HYP-PLAN-1) reached the capability and became a finding.
      assert.ok(validated.some((id) => id.startsWith("HYP-PLAN")), "planner proposal was validated");
      assert.ok(result.findings.some((f) => f.title === "model-proposed weakness"), "confirmed proposal is a finding");
      // The rule-based hunt still ran and was refuted -> unverified.
      assert.ok(result.unverified.some((u) => u.title === "rule-based claim"));
      assert.ok(result.audit.some((a) => a.capability === "red.planner" && a.outcome === "completed"));
    } finally {
      lab.server.close();
    }
  });

  it("a planner failure never breaks the campaign", async () => {
    const lab = await startLab();
    try {
      const result = await runCampaign(
        { goal: "g", authzId: null, targets: [lab.url] },
        {
          dataRoot: tempRoot(),
          bridge: noBridge,
          capabilities: [],
          planner: async () => {
            throw new Error("model down");
          },
        },
      );
      // No capabilities -> blue fallback still ran; campaign completed.
      assert.equal(result.stats.aborted, null);
      assert.ok(result.audit.some((a) => a.capability === "red.planner" && a.outcome === "failed"));
    } finally {
      lab.server.close();
    }
  });
});
