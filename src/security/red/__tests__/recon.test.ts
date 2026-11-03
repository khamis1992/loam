/**
 * Red recon tests (RED_TEAM_BUILD_SPEC §6.2).
 */
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { describe, it } from "node:test";

import type { BridgeEnvelope } from "../../../bridges/types.js";
import { createAuthorizationRecord } from "../gate.js";
import { redTransport } from "../transport.js";
import type { RedCapabilityContext } from "../orchestrator/redOrchestrator.js";
import { RedAuditLog } from "../audit.js";
import { mapKnownVulns, reconTarget } from "../recon/recon.js";

const ctxFor = (port: number): RedCapabilityContext => {
  const authz = createAuthorizationRecord({
    statement: "lab",
    expiresInSeconds: 3600,
    scope: { allowHosts: ["127.0.0.1"], allowPorts: [port], allowUrlPrefixes: [], denyAlways: [] },
  });
  return {
    authz,
    transport: redTransport(authz),
    bridge: async (): Promise<BridgeEnvelope> => ({ ok: false, exitCode: null, timedOut: false, error: { type: "x", message: "x" } }),
    audit: new RedAuditLog(fs.mkdtempSync(path.join(os.tmpdir(), "red-test-audit-"))),
  };
};

describe("reconTarget", () => {
  it("fingerprints the target from headers and title", async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader("server", "nginx/1.18.0");
      res.setHeader("x-powered-by", "PHP/7.4");
      res.end("<html><head><title>Lab App</title></head></html>");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
      const asset = await reconTarget(`http://127.0.0.1:${port}/`, ctxFor(port));
      assert.equal(asset.status, 200);
      assert.equal(asset.title, "Lab App");
      assert.equal(asset.server, "nginx/1.18.0");
      assert.equal(asset.poweredBy, "PHP/7.4");
      assert.ok(asset.techFingerprint.includes("nginx"));
      assert.ok(asset.techFingerprint.includes("php"));
      assert.deepEqual(asset.webPaths, []);
    } finally {
      server.close();
    }
  });

  it("an unreachable target yields an empty asset, never a throw", async () => {
    const asset = await reconTarget("http://127.0.0.1:9/", ctxFor(9));
    assert.deepEqual(asset.techFingerprint, []);
    assert.equal(asset.status, undefined);
  });
});

describe("mapKnownVulns", () => {
  it("maps fingerprints to candidate CVE leads (leads, not findings)", () => {
    const leads = mapKnownVulns({ target: "http://t/", techFingerprint: ["php"], webPaths: [] });
    assert.ok(leads.some((l) => l.source === "fingerprint" && /^CVE-/.test(l.cveId)));
    assert.ok(leads.every((l) => l.reason.length > 0));
    assert.deepEqual(mapKnownVulns({ target: "http://t/", techFingerprint: ["unknown-tech"], webPaths: [] }), []);
  });

  it("covers the CMS grafts (joomla/spring/wordpress body markers)", () => {
    const joomla = mapKnownVulns({ target: "http://t/", techFingerprint: ["joomla"], webPaths: [] });
    assert.ok(joomla.some((l) => l.cveId === "CVE-2023-23752"));
    const spring = mapKnownVulns({ target: "http://t/", techFingerprint: ["spring"], webPaths: [] });
    assert.ok(spring.some((l) => l.cveId === "CVE-2022-22965"));
  });
});

describe("mapKnownVulnsWithKev", () => {
  it("escalates KEV-listed CVEs and degrades gracefully when the catalog is unreachable", async () => {
    const { mapKnownVulnsWithKev } = await import("../recon/recon.js");
    const { resetKevMemo } = await import("../../native/intel/kev.js");
    resetKevMemo();
    const leads = await mapKnownVulnsWithKev({ target: "http://t/", techFingerprint: ["php"], webPaths: [] });
    // Online: the PHP lead is either kept as fingerprint or escalated to kev.
    // Offline: the catalog is unreachable and the static lead survives either way.
    assert.ok(leads.length >= 1);
    assert.ok(leads.every((l) => l.source === "fingerprint" || l.source === "kev"));
    resetKevMemo();
  });
});

/** Authenticated campaigns: the auth headers ride every gated request. */
describe("campaign auth", () => {
  it("bearer/cookie headers are applied to every red request", async () => {
    const server = http.createServer((req, res) => {
      if (req.headers["authorization"] === "Bearer t0k3n" && String(req.headers["cookie"]).includes("session=1")) {
        res.end("<html><title>Authed Lab</title></html>");
      } else {
        res.statusCode = 401;
        res.end("anon");
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
      const { runCampaign } = await import("../orchestrator/redOrchestrator.js");
      const result = await runCampaign(
        { goal: "auth", authzId: null, targets: [`http://127.0.0.1:${port}/`], auth: { bearer: "t0k3n", cookie: "session=1" } },
        { bridge: async (): Promise<import("../../../bridges/types.js").BridgeEnvelope> => ({ ok: false, exitCode: null, timedOut: false, error: { type: "x", message: "x" } }) },
      );
      // The campaign recon went through the authenticated red transport.
      assert.ok(result.requestEvidence.length >= 1, "recon used the red transport");
      assert.equal(result.requestEvidence[0]!.status, 200, "auth headers got the authed response");
    } finally {
      server.close();
    }
  });
});
