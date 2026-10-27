/**
 * Red-team authorization gate tests (spec §0.4).
 *
 * The gate is the single most important control in the red build: default-deny
 * allow-list, signed expiring authorization records, deny-list, rate limits,
 * kill-switch, destructive-action human approval and the zero-config localhost
 * fallback posture.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";

import {
  RateLimiter,
  authorizationActive,
  cidrMatch,
  createAuthorizationRecord,
  engageKillSwitch,
  gate,
  listAuthorizations,
  loadAuthorization,
  resetKillSwitch,
  saveAuthorization,
  targetInScope,
  type AuthorizationRecord,
  type GateState,
} from "../gate.js";

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "loam-red-gate-"));

const baseAuthz = (): AuthorizationRecord =>
  createAuthorizationRecord({
    statement: "I own the lab assets listed in scope",
    expiresInSeconds: 3600,
    scope: {
      allowHosts: ["127.0.0.1", "10.0.0.5"],
      allowPorts: [3000, 8080],
      allowUrlPrefixes: ["http://192.168.10.20:4317/api"],
      denyAlways: ["169.254.169.254", "10.0.0.9"],
    },
  });

describe("authorization record lifecycle", () => {
  it("creates a signed record with defaults from spec §0.4", () => {
    const a = baseAuthz();
    assert.match(a.id, /^AUTHZ-\d{4}$/);
    assert.equal(a.owner, "khamis");
    assert.equal(a.limits.maxReqPerSec, 10);
    assert.equal(a.limits.maxConcurrent, 4);
    assert.equal(a.limits.destructiveAllowed, false);
    assert.ok(a.authorization.acknowledgedAt <= new Date().toISOString());
  });

  it("persists immutably: a duplicate id is refused", () => {
    const root = tempRoot();
    const a = baseAuthz();
    saveAuthorization(a, root);
    assert.throws(() => saveAuthorization(a, root));
    const loaded = loadAuthorization(a.id, root);
    assert.ok(loaded);
    assert.equal(loaded.id, a.id);
    assert.equal(loadAuthorization("AUTHZ-9999", root), null);
    assert.equal(listAuthorizations(root).length, 1);
  });

  it("expired authorization is inactive", () => {
    const a = baseAuthz();
    assert.equal(authorizationActive(a), true);
    const expired = createAuthorizationRecord({ statement: "s", expiresInSeconds: -10, scope: { allowHosts: ["127.0.0.1"], allowPorts: [], allowUrlPrefixes: [], denyAlways: [] } });
    assert.equal(authorizationActive(expired, new Date()), false);
  });
});

describe("scope matching", () => {
  it("allows only allow-listed hosts and ports", () => {
    const s = baseAuthz().scope;
    assert.equal(targetInScope(s, "http://127.0.0.1:3000/app"), true);
    assert.equal(targetInScope(s, "http://example.com:3000/app"), false);
    assert.equal(targetInScope(s, "http://127.0.0.1:9999/app"), false);
  });

  it("matches IPv4 CIDRs in allowHosts", () => {
    const s = baseAuthz().scope;
    assert.equal(targetInScope(s, "http://10.0.0.5:3000/"), true);
    const cidrScope = { allowHosts: ["10.0.0.0/24"], allowPorts: [], allowUrlPrefixes: [], denyAlways: [] };
    assert.equal(targetInScope(cidrScope, "http://10.0.0.7:80/"), true);
    assert.equal(targetInScope(cidrScope, "http://10.0.1.7:80/"), false);
  });

  it("deny-list wins over the allow-list", () => {
    const s = baseAuthz().scope;
    assert.equal(targetInScope(s, "http://10.0.0.9:3000/"), false);
    assert.equal(targetInScope(s, "http://169.254.169.254/latest/meta-data"), false);
  });

  it("url-prefix matching allows an exact prefix path", () => {
    const s = baseAuthz().scope;
    assert.equal(targetInScope(s, "http://192.168.10.20:4317/api/users"), true);
    assert.equal(targetInScope(s, "http://192.168.10.20:4317/admin"), false);
  });

  it("invalid URLs are out of scope", () => {
    assert.equal(targetInScope(baseAuthz().scope, "not a url"), false);
  });
});

describe("cidrMatch", () => {
  it("matches IPv4 inside the block and rejects outside", () => {
    assert.equal(cidrMatch("10.0.0.0/24", "10.0.0.7"), true);
    assert.equal(cidrMatch("10.0.0.0/24", "10.0.1.7"), false);
    assert.equal(cidrMatch("0.0.0.0/0", "8.8.8.8"), true);
    assert.equal(cidrMatch("10.0.0.0/24", "not-an-ip"), false);
    assert.equal(cidrMatch("garbage/24", "10.0.0.7"), false);
  });
});

describe("gate decisions (spec §0.4 order)", () => {
  const read = { capability: "red.recon", verb: "read" as const };
  const destructive = { capability: "red.sqli", verb: "write" as const, destructive: true };

  beforeEach(() => resetKillSwitch());

  it("no authorization: localhost read-only is allowed (zero-config default), others denied", () => {
    const local = gate("http://127.0.0.1:3000/x", read, null);
    assert.deepEqual(local, { allow: true, reason: "localhost default posture", authzId: null });
    const remote = gate("http://192.168.1.5:80/x", read, null);
    assert.equal(remote.allow, false);
    assert.equal(remote.reason, "no authorization record");
    const localDestructive = gate("http://127.0.0.1:3000/x", destructive, null);
    assert.equal(localDestructive.allow, false);
    assert.equal(localDestructive.reason, "destructive action requires approval");
  });

  it("expired authorization is denied", () => {
    const expired = createAuthorizationRecord({ statement: "s", expiresInSeconds: -60, scope: { allowHosts: ["127.0.0.1"], allowPorts: [], allowUrlPrefixes: [], denyAlways: [] } });
    const d = gate("http://127.0.0.1:3000/x", read, expired);
    assert.equal(d.allow, false);
    assert.equal(d.reason, "authorization expired");
  });

  it("deny-listed and out-of-scope targets are denied even with an active record", () => {
    const a = baseAuthz();
    assert.equal(gate("http://10.0.0.9:3000/x", read, a).reason, "target on deny-list");
    assert.equal(gate("http://example.com:3000/x", read, a).reason, "target outside authorization scope");
  });

  it("destructive actions always require human approval", () => {
    const a = baseAuthz();
    assert.equal(gate("http://127.0.0.1:3000/x", destructive, a).reason, "destructive action requires approval");
    const approved = gate("http://127.0.0.1:3000/x", destructive, a, { approval: () => true });
    assert.equal(approved.allow, true);
    assert.equal(approved.reason, "destructive action approved");
    const recordAllows = createAuthorizationRecord({ statement: "s", expiresInSeconds: 60, destructiveAllowed: true, scope: { allowHosts: ["127.0.0.1"], allowPorts: [], allowUrlPrefixes: [], denyAlways: [] } });
    assert.equal(gate("http://127.0.0.1:3000/x", destructive, recordAllows).allow, false);
    assert.equal(gate("http://127.0.0.1:3000/x", destructive, recordAllows, { approval: () => true }).allow, true);
  });

  it("rate limiter exceeded is denied", () => {
    const a = baseAuthz();
    const limiter = new RateLimiter(2, 4);
    assert.equal(gate("http://127.0.0.1:3000/x", read, a, { limiter }).allow, true);
    assert.equal(gate("http://127.0.0.1:3000/x", read, a, { limiter }).allow, true);
    const d = gate("http://127.0.0.1:3000/x", read, a, { limiter });
    assert.equal(d.allow, false);
    assert.equal(d.reason, "rate limit exceeded");
  });

  it("request budget reached is denied", () => {
    const a = baseAuthz();
    let used = 0;
    const deps = { requestCount: () => used };
    used = a.limits.maxTotalRequests;
    const d = gate("http://127.0.0.1:3000/x", read, a, deps);
    assert.equal(d.allow, false);
    assert.equal(d.reason, "request budget reached");
  });

  it("kill-switch denies everything, including in-flight approvals", () => {
    engageKillSwitch();
    try {
      const d = gate("http://127.0.0.1:3000/x", read, baseAuthz());
      assert.equal(d.allow, false);
      assert.equal(d.reason, "kill-switch engaged");
    } finally {
      resetKillSwitch();
    }
  });

  it("an in-scope read action is allowed with the authz id", () => {
    const a = baseAuthz();
    const d = gate("http://127.0.0.1:3000/x", read, a);
    assert.deepEqual(d, { allow: true, reason: "", authzId: a.id });
  });
});

describe("RateLimiter", () => {
  it("enforces concurrency and per-second ceilings", () => {
    const rl = new RateLimiter(10, 2);
    assert.equal(rl.tryAcquire(), true);
    assert.equal(rl.tryAcquire(), true);
    assert.equal(rl.tryAcquire(), false); // concurrency 2 exceeded
    rl.release();
    assert.equal(rl.tryAcquire(), true);
    const fast = new RateLimiter(2, 10);
    assert.equal(fast.tryAcquire(), true);
    assert.equal(fast.tryAcquire(), true);
    assert.equal(fast.tryAcquire(), false); // per-second 2 exceeded
  });
});
