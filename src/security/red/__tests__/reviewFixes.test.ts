/**
 * Regression tests for the red-team review findings (P0).
 *
 * Every test reproduces a defect demonstrated during the review; each must fail
 * on the unfixed tree and pass after the corresponding root-cause fix.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";

import type { BridgeEnvelope } from "../../../bridges/types.js";
import {
  createAuthorizationRecord,
  engageKillSwitch,
  gate,
  RateLimiter,
  resetKillSwitch,
  saveAuthorization,
  targetInScope,
  type AuthorizationRecord,
} from "../gate.js";
import { redTransport } from "../transport.js";
import { runCampaign, type RedCapability, type RedHypothesis, type RedValidation } from "../orchestrator/redOrchestrator.js";

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "loam-red-review-"));
const noBridge = async (): Promise<BridgeEnvelope> => ({ ok: false, exitCode: null, timedOut: false, error: { type: "x", message: "x" } });
const servers: http.Server[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
  resetKillSwitch();
});

async function lab(handler: http.RequestListener = (_req, res) => res.end("ok")) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const port = (server.address() as import("node:net").AddressInfo).port;
  return { server, port, url: `http://127.0.0.1:${port}` };
}

const recordFor = (port: number, id = "AUTHZ-7001"): AuthorizationRecord =>
  createAuthorizationRecord({
    id,
    statement: "review lab",
    expiresInSeconds: 3600,
    scope: { allowHosts: ["127.0.0.1"], allowPorts: [port], allowUrlPrefixes: [], denyAlways: [] },
  });

describe("P0 gate decisions are terminal", () => {
  it("does not validate a hypothesis whose target was denied", async () => {
    let calls = 0;
    const cap: RedCapability = {
      id: "red.probe",
      applicable: () => true,
      hunt: async (): Promise<RedHypothesis[]> => [{ id: "HYP-OUT", capability: "red.probe", target: "http://192.168.99.99/", claim: "out of scope" }],
      validate: async (hyp): Promise<RedValidation> => {
        calls++;
        return { hypothesisId: hyp.id, status: "refuted", claim: hyp.claim, detail: "must not run", evidence: [] };
      },
    };
    const result = await runCampaign(
      { goal: "deny", authzId: null, targets: ["http://127.0.0.1:3000/"] },
      { dataRoot: tempRoot(), capabilities: [cap], bridge: noBridge },
    );
    assert.equal(calls, 0, "a denied hypothesis must never reach validate");
    assert.ok(result.audit.some((a) => a.outcome === "denied"));
  });

  it("does not validate after a post-hunt denial (authorization expires during hunt)", async () => {
    const root = tempRoot();
    const labServer = await lab();
    const rec = recordFor(labServer.port);
    saveAuthorization(rec, root);
    let now = new Date();
    let calls = 0;
    const cap: RedCapability = {
      id: "red.probe",
      applicable: () => true,
      hunt: async (target): Promise<RedHypothesis[]> => {
        now = new Date(now.getTime() + 7_200_000);
        return [{ id: "HYP-EXPIRE", capability: "red.probe", target, claim: "post-hunt denial" }];
      },
      validate: async (hyp): Promise<RedValidation> => {
        calls++;
        return { hypothesisId: hyp.id, status: "refuted", claim: hyp.claim, detail: "must not run", evidence: [] };
      },
    };
    await runCampaign(
      { goal: "expire", authzId: rec.id, targets: [labServer.url] },
      { dataRoot: root, capabilities: [cap], bridge: noBridge, gateDeps: { now: () => now } },
    );
    assert.equal(calls, 0, "post-hunt denial must skip every validation for that capability");
  });

  it("kill-switch engaged before the campaign aborts and audits killswitch_engaged", async () => {
    engageKillSwitch();
    const result = await runCampaign(
      { goal: "kill", authzId: null, targets: ["http://127.0.0.1:3000/"] },
      { dataRoot: tempRoot(), capabilities: [], bridge: noBridge },
    );
    assert.equal(result.stats.killed, true);
    assert.ok(result.audit.some((a) => a.outcome === "killswitch_engaged"));
  });
});

describe("P0 rate limiter lifecycle", () => {
  it("sequential requests acquire once and release once (no slot leak)", async () => {
    const labServer = await lab();
    const rec = recordFor(labServer.port);
    const limiter = new RateLimiter(100, 2);
    const transport = redTransport(rec, { limiter });
    for (let i = 0; i < 4; i++) {
      const res = await transport.request(labServer.url);
      assert.equal(res.status, 200, `request ${i + 1} must not be denied`);
    }
  });
});

describe("P0 scope and credential boundaries", () => {
  it("rejects credentials embedded in a target URL", () => {
    const rec = createAuthorizationRecord({
      statement: "scope",
      expiresInSeconds: 60,
      scope: { allowHosts: ["127.0.0.1"], allowPorts: [3000], allowUrlPrefixes: [], denyAlways: [] },
    });
    const decision = gate("http://user:pass@127.0.0.1:3000/", { capability: "probe", verb: "read" }, rec);
    assert.equal(decision.allow, false);
  });

  it("URL prefixes match whole path segments only", () => {
    const rec = createAuthorizationRecord({
      statement: "scope",
      expiresInSeconds: 60,
      scope: { allowHosts: [], allowPorts: [], allowUrlPrefixes: ["http://192.168.10.20:4317/api"], denyAlways: [] },
    });
    assert.equal(targetInScope(rec.scope, "http://192.168.10.20:4317/api/users"), true);
    assert.equal(targetInScope(rec.scope, "http://192.168.10.20:4317/api2"), false);
  });

  it("public-space CIDR wildcards are rejected", () => {
    assert.throws(() =>
      createAuthorizationRecord({
        statement: "scope",
        expiresInSeconds: 60,
        scope: { allowHosts: ["0.0.0.0/0"], allowPorts: [], allowUrlPrefixes: [], denyAlways: [] },
      }),
    );
    assert.equal(targetInScope({ allowHosts: ["0.0.0.0/0"], allowPorts: [], allowUrlPrefixes: [], denyAlways: [] }, "http://8.8.8.8/"), false);
  });

  it("authenticated campaigns are restricted to one origin before any request", async () => {
    const a = await lab();
    const b = await lab();
    let error: Error | null = null;
    try {
      await runCampaign(
        { goal: "auth", authzId: null, targets: [a.url, b.url], auth: { bearer: "t0k3n" } },
        { dataRoot: tempRoot(), capabilities: [], bridge: noBridge },
      );
    } catch (e) {
      error = e as Error;
    }
    assert.ok(error, "two authenticated origins must be rejected");
    assert.match(error!.message, /one origin/i);
  });
});

describe("P0 bridge effect approval", () => {
  it("external/exec_script effects are denied without approval and run with it", async () => {
    let calls = 0;
    const cap: RedCapability = {
      id: "red.bridge",
      applicable: () => true,
      hunt: async (target): Promise<RedHypothesis[]> => [{ id: "HYP-BRIDGE", capability: "red.bridge", target, claim: "engine" }],
      validate: async (hyp, ctx): Promise<RedValidation> => {
        const env = await ctx.bridge("red-nuclei", "scan", { target: hyp.target, severity: "low" });
        return { hypothesisId: hyp.id, status: env.ok ? "refuted" : "inconclusive", claim: hyp.claim, detail: env.error?.message ?? "ran", evidence: [] };
      },
    };
    const target = "http://127.0.0.1:3000/";
    const countingBridge = async (): Promise<BridgeEnvelope> => {
      calls++;
      return noBridge();
    };
    const denied = await runCampaign({ goal: "deny", authzId: null, targets: [target] }, { dataRoot: tempRoot(), capabilities: [cap], bridge: countingBridge });
    assert.equal(calls, 0, "external bridge must not run without approval");
    assert.ok(denied.audit.some((a) => a.outcome === "denied" && a.reason === "bridge effect requires approval"));

    const allowed = await runCampaign(
      { goal: "allow", authzId: null, targets: [target] },
      { dataRoot: tempRoot(), capabilities: [cap], bridge: countingBridge, bridgeApproval: () => true },
    );
    assert.equal(calls, 1, "approved effect executes exactly once");
    assert.ok(allowed.audit.some((a) => a.outcome === "allowed"));
  });
});
