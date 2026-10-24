/**
 * Lab-only C2 listener + WiFi audit tests (RED_TEAM_BUILD_SPEC §6.10, §6.11).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { describe, it } from "node:test";

import type { BridgeEnvelope } from "../../../bridges/types.js";
import { RedAuditLog } from "../audit.js";
import { createAuthorizationRecord } from "../gate.js";
import { redTransport } from "../transport.js";
import type { RedCapabilityContext } from "../orchestrator/redOrchestrator.js";
import { awaitCallback } from "../c2/labListener.js";
import { bssidAllowed, captureHandshake, parseFreewayScan, scanWifi, type WifiScope } from "../wifi/freeway.js";

const ctxFor = (port: number, bridge?: RedCapabilityContext["bridge"]): RedCapabilityContext => {
  const authz = createAuthorizationRecord({
    statement: "lab",
    expiresInSeconds: 3600,
    scope: { allowHosts: ["127.0.0.1"], allowPorts: [port], allowUrlPrefixes: [], denyAlways: [] },
  });
  return {
    authz,
    transport: redTransport(authz),
    bridge: bridge ?? (async (): Promise<BridgeEnvelope> => ({ ok: false, exitCode: null, timedOut: false, error: { type: "x", message: "x" } })),
    audit: new RedAuditLog(fs.mkdtempSync(path.join(os.tmpdir(), "loam-red-lab-"))),
  };
};

describe("lab callback listener", () => {
  it("resolves on the first loopback callback and records the proof", async () => {
    // Reserve an ephemeral port, close it, and let the listener take it.
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = (probe.address() as import("node:net").AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const ctx = ctxFor(port);
    const waiting = awaitCallback(port, 5, { authzId: null, audit: ctx.audit });
    // Simulate the exploit's callback (lab only).
    await fetch(`http://127.0.0.1:${port}/oob-proof?gadget=URLDNS`);
    const proof = await waiting;
    assert.equal(proof.path.startsWith("/oob-proof"), true);
    assert.ok(proof.at);
    assert.ok(ctx.audit.read().some((a) => a.outcome === "completed" && a.capability === "red.lab_listener"));
  });

  it("rejects on timeout with an audit entry", async () => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = (probe.address() as import("node:net").AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const ctx = ctxFor(port);
    await assert.rejects(() => awaitCallback(port, 0.05, { authzId: null, audit: ctx.audit }), /timeout/);
    assert.ok(ctx.audit.read().some((a) => a.outcome === "failed" && a.reason === "callback timeout"));
  });
});

describe("wifi audit", () => {
  const scope: WifiScope = { authzId: null, allowBssids: ["AA:BB:CC:DD:EE:01"] };

  it("bssid allow-list denies foreign APs", () => {
    assert.deepEqual(bssidAllowed(scope, "AA:BB:CC:DD:EE:01"), { allow: true });
    const denied = bssidAllowed(scope, "11:22:33:44:55:66");
    assert.equal(denied.allow, false);
    assert.match(denied.reason, /allow-list/);
  });

  it("parseFreewayScan reads the bridge contract and scanWifi filters to owned APs", async () => {
    const networks = parseFreewayScan(JSON.stringify({ networks: [
      { bssid: "AA:BB:CC:DD:EE:01", ssid: "LabAP", clients: ["c1"] },
      { bssid: "11:22:33:44:55:66", ssid: "NeighbourAP", clients: [] },
      { ssid: "no-bssid" },
    ] }));
    assert.equal(networks.length, 2);
    const ctx = ctxFor(1, async () => ({
      ok: true, exitCode: 0, timedOut: false,
      text: JSON.stringify({ networks: [
        { bssid: "AA:BB:CC:DD:EE:01", ssid: "LabAP", clients: ["c1"] },
        { bssid: "11:22:33:44:55:66", ssid: "NeighbourAP", clients: [] },
      ] }),
    }));
    const owned = await scanWifi(ctx, scope);
    assert.equal(owned.length, 1);
    assert.equal(owned[0]!.ssid, "LabAP");
  });

  it("captureHandshake is denied for a foreign BSSID and audited", async () => {
    const ctx = ctxFor(1);
    const result = await captureHandshake(ctx, scope, "11:22:33:44:55:66");
    assert.equal(result.ok, false);
    assert.match(result.detail, /allow-list/);
    assert.ok(ctx.audit.read().some((a) => a.outcome === "denied" && a.target === "11:22:33:44:55:66"));
    const ok = await captureHandshake(ctx, scope, "AA:BB:CC:DD:EE:01");
    assert.equal(ok.ok, false); // bridge missing in this ctx, but the allow-list passed
    assert.match(ok.detail, /freeway capture failed/);
  });
});
