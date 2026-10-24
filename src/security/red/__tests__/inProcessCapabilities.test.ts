/**
 * In-process capability tests: SSRF modules and deserialization (spec §6.4, §6.8)
 * against a local lab server. Destructive gadget execution is never the default.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";

import type { BridgeEnvelope } from "../../../bridges/types.js";
import { RedAuditLog } from "../audit.js";
import { createAuthorizationRecord } from "../gate.js";
import { redTransport } from "../transport.js";
import type { RedCapabilityContext } from "../orchestrator/redOrchestrator.js";
import { ssrfCapability, ssrfModulePayloads } from "../ssrf.js";
import { deserCapability } from "../deser.js";

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
    audit: new RedAuditLog(),
  };
};

describe("ssrfModulePayloads", () => {
  it("module lists match the documented SSRFmap surface", () => {
    assert.ok(ssrfModulePayloads("metadata").some((v) => v.includes("169.254.169.254")));
    assert.ok(ssrfModulePayloads("fileRead").some((v) => v.startsWith("file:///")));
    assert.ok(ssrfModulePayloads("gopher")[0]!.startsWith("gopher://"));
    assert.ok(ssrfModulePayloads("dict")[0]!.startsWith("dict://"));
    assert.ok(ssrfModulePayloads("internalPortscan").length >= 5);
  });
});

describe("ssrf capability", () => {
  it("a lab endpoint fetching the injected URL is proven with a PoC finding", async () => {
    // Lab app that really fetches the URL parameter server-side.
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/fetch") {
        const target = url.searchParams.get("url") ?? "";
        if (target.startsWith("file:///")) {
          res.end("HOSTNAME=lab-host\n");
        } else if (target.includes("169.254.169.254")) {
          res.end("ami-id: ami-012345\n");
        } else {
          res.statusCode = 404;
          res.end("nope");
        }
        return;
      }
      res.end("home");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as import("node:net").AddressInfo).port;
    const ctx = ctxFor(port);
    const cap = ssrfCapability({ probeTemplate: `http://127.0.0.1:${port}/fetch?url={SSRF}` });
    const target = `http://127.0.0.1:${port}/fetch`;
    try {
      const hyps = await cap.hunt(target, { target, techFingerprint: [], webPaths: [] }, ctx);
      assert.ok(hyps.length >= 1);
      const v = await cap.validate(hyps[0]!, ctx);
      assert.equal(v.status, "confirmed", `first probe should prove SSRF: ${v.detail}`);
      assert.equal(v.finding!.check, "red_ssrf_module");
      assert.ok(v.evidence.some((e) => e.kind === "poc"));
      // A non-fetching endpoint refutes the claim (marker missing).
      const plain = `http://127.0.0.1:${port}/home`;
      const cap2 = ssrfCapability({ probeTemplate: `http://127.0.0.1:${port}/home?url={SSRF}`, markers: ["ami-id"] });
      const hyp2 = (await cap2.hunt(plain, { target: plain, techFingerprint: [], webPaths: [] }, ctx))[0]!;
      const v2 = await cap2.validate(hyp2, ctx);
      assert.equal(v2.status, "refuted");
    } finally {
      server.close();
    }
  });
});

describe("deser capability", () => {
  it("an endpoint echoing a deser marker is proven; missing jar is inconclusive", async () => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/deserialize" && body.includes("rO0AB")) {
          res.statusCode = 500;
          res.end("java.io.ObjectInputStream: rejected payload");
        } else {
          res.end("ok");
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as import("node:net").AddressInfo).port;
    const authz = createAuthorizationRecord({
      statement: "lab",
      expiresInSeconds: 3600,
      scope: { allowHosts: ["127.0.0.1"], allowPorts: [port], allowUrlPrefixes: [], denyAlways: [] },
    });
    const ctx: RedCapabilityContext = {
      authz,
      transport: redTransport(authz),
      bridge: async (): Promise<BridgeEnvelope> => ({
        ok: true, exitCode: 0, timedOut: false, text: "rO0ABXNyABFqYXZhLnV0aWwuSGFzaE1hcA==",
      }),
      audit: new RedAuditLog(),
    };
    try {
      const cap = deserCapability({ jar: "ysoserial.jar" });
      const target = `http://127.0.0.1:${port}`;
      const hyp = (await cap.hunt(target, { target, techFingerprint: [], webPaths: [] }, ctx))[0]!;
      const v = await cap.validate(hyp, ctx);
      assert.equal(v.status, "confirmed");
      assert.equal(v.finding!.check, "red_deserialization");
      assert.equal(v.finding!.severity, "critical");
      // Bridge missing -> inconclusive (never a finding without proof).
      const ctxNoJar: RedCapabilityContext = { ...ctx, bridge: async () => ({ ok: false, exitCode: 1, timedOut: false, error: { type: "x", message: "jar missing" } }) };
      const v2 = await deserCapability({ jar: "ysoserial.jar" }).validate(hyp, ctxNoJar);
      assert.equal(v2.status, "inconclusive");
    } finally {
      server.close();
    }
  });
});
