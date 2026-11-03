/**
 * Red campaign orchestrator tests (RED_TEAM_BUILD_SPEC §4.2, §6.1, §9).
 *
 * The campaign is the brain: gate every target, recon, route to capabilities,
 * prove every claim through the evidence gate, audit every action, and fall
 * back to the existing (blue) evidence-gated loop for plain localhost targets.
 * All safety negative tests from spec §9 run here against a local lab server.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";

import { engageKillSwitch, resetKillSwitch, saveAuthorization } from "../gate.js";
import type { AuthorizationRecord } from "../gate.js";
import type { BridgeEnvelope } from "../../../bridges/types.js";
import type { Evidence } from "../../orchestrator.js";
import { runCampaign, type RedCapability, type RedCapabilityContext, type RedHypothesis, type RedValidation } from "../orchestrator/redOrchestrator.js";

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "loam-red-campaign-"));

const startLab = async (): Promise<{ server: http.Server; url: string; port: number }> => {
  const server = http.createServer((req, res) => {
    if (req.url === "/.env") {
      res.end("SECRET=1\n");
      return;
    }
    // Planted weakness: no security headers at all.
    res.end("<html><title>Lab App</title></html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address() as import("node:net").AddressInfo;
  return { server, url: `http://127.0.0.1:${addr.port}`, port: addr.port };
};

const labs: http.Server[] = [];
afterEach(() => {
  while (labs.length) labs.pop()!.close();
  resetKillSwitch();
});

const noBridge = async (): Promise<BridgeEnvelope> => ({ ok: false, exitCode: null, timedOut: false, error: { type: "no_bridge", message: "no bridge caller configured" } });

describe("runCampaign", () => {
  it("blue fallback: a localhost target with no red capabilities runs the existing evidence-gated loop and proves a finding", async () => {
    const lab = await startLab();
    labs.push(lab.server);
    const result = await runCampaign(
      { goal: "assess lab", authzId: null, targets: [lab.url] },
      { dataRoot: tempRoot(), bridge: noBridge },
    );
    assert.ok(result.findings.length >= 1, "at least one gate-passing finding (missing security headers)");
    const f = result.findings[0]!;
    assert.ok(f.id && f.fingerprint, "finding has a fingerprint");
    assert.ok(f.requestIds.length >= 1, "finding references evidence");
    assert.ok(result.evidence.length >= 1, "evidence recorded");
    assert.ok(result.evidence.every((e) => /^EV\d{4}$/.test(e.id) || e.id.startsWith("EV")), "EV-#### evidence ids");
    assert.equal(result.stats.killed, false);
    assert.ok(result.audit.length >= 1, "audit trail exists");
    assert.ok(result.audit.some((a) => a.outcome === "allowed" && a.target === lab.url));
  });

  it("routes to an applicable red capability and gates its claims through the evidence gate", async () => {
    const lab = await startLab();
    labs.push(lab.server);
    const evidence: Evidence[] = [
      { id: "EV9001", kind: "poc", at: new Date().toISOString(), poc: "GET /.env", observed: "HTTP 200 returned SECRET=1" },
    ];
    const capability: RedCapability = {
      id: "red.exposed",
      applicable: () => true,
      hunt: async (): Promise<RedHypothesis[]> => [
        { id: "HYP0001", capability: "red.exposed", target: lab.url, claim: "Exposed .env file", rationale: "recon" },
      ],
      validate: async (hyp): Promise<RedValidation> => ({
        hypothesisId: hyp.id,
        status: "confirmed",
        claim: hyp.claim,
        detail: "HTTP 200 returned SECRET=1",
        evidence,
        finding: { check: "red_exposed", verdict: "finding", severity: "high", title: "Exposed .env file", target: lab.url, detail: "Retrievable .env" },
      }),
    };
    const result = await runCampaign(
      { goal: "assess lab", authzId: null, targets: [lab.url] },
      { dataRoot: tempRoot(), bridge: noBridge, capabilities: [capability] },
    );
    assert.ok(result.findings.some((f) => f.check === "red_exposed"), "capability finding recorded");
    const unproven: RedCapability = {
      id: "red.unproven",
      applicable: () => true,
      hunt: async () => [{ id: "HYP0002", capability: "red.unproven", target: lab.url, claim: "Claim without proof" }],
      validate: async (hyp) => ({ hypothesisId: hyp.id, status: "confirmed", claim: hyp.claim, detail: "no evidence attached", evidence: [] }),
    };
    const result2 = await runCampaign(
      { goal: "assess lab", authzId: null, targets: [lab.url] },
      { dataRoot: tempRoot(), bridge: noBridge, capabilities: [unproven] },
    );
    assert.equal(result2.findings.filter((f) => f.check === "red_unproven").length, 0, "no finding without proof");
    assert.ok(result2.unverified.some((u) => u.check === "red_unproven"), "claim withheld with reason");
    assert.ok(result2.unverified.find((u) => u.check === "red_unproven")!.reason.length > 0);
  });

  it("safety negative (§9a): an out-of-scope target is denied and audited, the campaign continues", async () => {
    const lab = await startLab();
    labs.push(lab.server);
    const result = await runCampaign(
      { goal: "assess lab", authzId: null, targets: ["http://192.168.99.99:3000/", lab.url] },
      { dataRoot: tempRoot(), bridge: noBridge },
    );
    const denied = result.audit.filter((a) => a.outcome === "denied" && a.target === "http://192.168.99.99:3000/");
    assert.ok(denied.length >= 1, "denial audited");
    assert.equal(denied[0]!.reason, "no authorization record");
    assert.ok(result.findings.length >= 1, "in-scope target still processed");
    const blockedNode = result.ptt.children.find((c) => c.goal === "http://192.168.99.99:3000/");
    assert.equal(blockedNode!.status, "blocked");
  });

  it("safety negative (§9b): an expired authorization denies the campaign's targets", async () => {
    const lab = await startLab();
    labs.push(lab.server);
    const root = tempRoot();
    const expired: AuthorizationRecord = {
      id: "AUTHZ-9001",
      owner: "khamis",
      scope: { allowHosts: ["127.0.0.1"], allowPorts: [lab.port], allowUrlPrefixes: [], denyAlways: [] },
      authorization: { statement: "lab", acknowledgedAt: new Date(Date.now() - 7200_000).toISOString(), expiresAt: new Date(Date.now() - 3600_000).toISOString() },
      limits: { maxReqPerSec: 10, maxConcurrent: 4, maxTotalRequests: 100, destructiveAllowed: false },
    };
    saveAuthorization(expired, root);
    const result = await runCampaign({ goal: "g", authzId: "AUTHZ-9001", targets: [lab.url] }, { dataRoot: root, bridge: noBridge });
    assert.equal(result.findings.length, 0);
    assert.ok(result.audit.some((a) => a.outcome === "denied" && a.reason === "authorization expired"));
  });

  it("safety negative (§9c): destructive validation without approval is blocked; with approval it runs", async () => {
    const lab = await startLab();
    labs.push(lab.server);
    const evidence: Evidence[] = [{ id: "EV9002", kind: "poc", at: new Date().toISOString(), poc: "POST /admin", observed: "row written" }];
    const cap: RedCapability = {
      id: "red.write",
      applicable: () => true,
      hunt: async (target): Promise<RedHypothesis[]> => [
        { id: "HYP0003", capability: "red.write", target, claim: "Writable admin endpoint" },
      ],
      validate: async (hyp): Promise<RedValidation> => ({
        hypothesisId: hyp.id,
        status: "confirmed",
        claim: hyp.claim,
        detail: "row written",
        evidence,
        finding: { check: "red_write", verdict: "finding", severity: "high", title: "Writable admin endpoint", target: lab.url, detail: "row written" },
      }),
    };
    // Default: a capability flagged destructive runs only when the approval callback says yes.
    const denied = await runCampaign(
      { goal: "g", authzId: null, targets: [lab.url] },
      { dataRoot: tempRoot(), bridge: noBridge, capabilities: [cap], destructiveCapabilities: ["red.write"] },
    );
    assert.equal(denied.findings.filter((f) => f.check === "red_write").length, 0, "destructive without approval yields no finding");
    assert.ok(denied.audit.some((a) => a.outcome === "denied" && a.reason === "destructive action requires approval"));
    const approved = await runCampaign(
      { goal: "g", authzId: null, targets: [lab.url] },
      { dataRoot: tempRoot(), bridge: noBridge, capabilities: [cap], destructiveCapabilities: ["red.write"], approval: () => true },
    );
    assert.equal(approved.findings.filter((f) => f.check === "red_write").length, 1, "approved destructive runs");
    assert.ok(approved.audit.some((a) => a.outcome === "destructive_approved"));
  });

  it("safety negative (§9d): kill-switch mid-campaign aborts and audits", async () => {
    const lab = await startLab();
    labs.push(lab.server);
    const slow: RedCapability = {
      id: "red.slow",
      applicable: () => true,
      hunt: async (target): Promise<RedHypothesis[]> => [
        { id: "HYP0001", capability: "red.slow", target, claim: "claim 1" },
        { id: "HYP0002", capability: "red.slow", target, claim: "claim 2" },
      ],
      validate: async (hyp): Promise<RedValidation> => {
        if (hyp.id === "HYP0001") engageKillSwitch(); // mid-campaign engagement
        return { hypothesisId: hyp.id, status: "refuted", claim: hyp.claim, detail: "not reproduced", evidence: [] };
      },
    };
    const result = await runCampaign(
      { goal: "g", authzId: null, targets: [lab.url] },
      { dataRoot: tempRoot(), bridge: noBridge, capabilities: [slow] },
    );
    assert.equal(result.stats.killed, true);
    assert.ok(result.audit.some((a) => a.outcome === "killswitch_engaged"));
  });

  it("safety negative (§9e): exceeding the request budget aborts the campaign", async () => {
    const lab = await startLab();
    labs.push(lab.server);
    const root = tempRoot();
    const budget: AuthorizationRecord = {
      id: "AUTHZ-9002",
      owner: "khamis",
      scope: { allowHosts: ["127.0.0.1"], allowPorts: [lab.port], allowUrlPrefixes: [], denyAlways: [] },
      authorization: { statement: "lab", acknowledgedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() },
      limits: { maxReqPerSec: 10, maxConcurrent: 4, maxTotalRequests: 1, destructiveAllowed: false },
    };
    saveAuthorization(budget, root);
    const hungry: RedCapability = {
      id: "red.hungry",
      applicable: () => true,
      hunt: async (target, _recon, ctx): Promise<RedHypothesis[]> => {
        // Consume the whole budget inside hunt; the transport denies the second.
        await ctx.transport.request(target).catch(() => {});
        await ctx.transport.request(target).catch(() => {});
        return [];
      },
      validate: async (hyp) => ({ hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: "", evidence: [] }),
    };
    const result = await runCampaign(
      { goal: "g", authzId: "AUTHZ-9002", targets: [lab.url] },
      { dataRoot: root, bridge: noBridge, capabilities: [hungry] },
    );
    assert.equal(result.stats.aborted, "budget", "campaign aborted for budget");
    assert.ok(result.audit.some((a) => a.outcome === "denied" && a.reason === "request budget reached"));
  });
});
