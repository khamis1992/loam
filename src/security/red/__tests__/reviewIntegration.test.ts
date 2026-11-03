/**
 * Integration tests for the remaining spec gaps: ATT&CK campaigns, blue-block
 * detection catalogue, lab callback proof and the real kill-switch UI control.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";

import { createAuthorizationRecord, engageKillSwitch, isKillSwitchEngaged, resetKillSwitch } from "../gate.js";
import { redTransport } from "../transport.js";
import { RedAuditLog } from "../audit.js";
import { runCampaign } from "../orchestrator/redOrchestrator.js";
import { buildRedReport } from "../report.js";
import type { RedCapabilityContext } from "../orchestrator/redOrchestrator.js";

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "loam-red-integration-"));
const servers: http.Server[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
  resetKillSwitch();
});

async function lab(handler: http.RequestListener) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const port = (server.address() as import("node:net").AddressInfo).port;
  return { server, port, url: `http://127.0.0.1:${port}` };
}

function ctxFor(port: number): RedCapabilityContext {
  const authz = createAuthorizationRecord({
    statement: "lab",
    expiresInSeconds: 3600,
    scope: { allowHosts: ["127.0.0.1"], allowPorts: [port], allowUrlPrefixes: [], denyAlways: [] },
  });
  return { authz, transport: redTransport(authz), bridge: async () => ({ ok: true, exitCode: 0, timedOut: false, text: "gadget" }), audit: new RedAuditLog(tempRoot()) };
}

describe("red tradecraft in the blue catalogue", () => {
  it("registers detection signatures as a blue audit domain", async () => {
    const { DOMAINS } = await import("../../audit/blocks/domains.js");
    const domain = DOMAINS.find((d) => d.id === "loam-audit/redTeamTradecraft");
    assert.ok(domain, "redTeamTradecraft domain is registered");
    assert.ok(domain!.universalMoves.some((m) => m.includes("1102")), "log-clear detection reaches the blue block");
    assert.ok(domain!.classes.some((c) => c.name.includes("Function Stomping")));
  });
});

describe("Caldera campaign integration", () => {
  it("imports operation coverage into the campaign and report", async () => {
    const labServer = await lab((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/adversaries") return res.end(JSON.stringify([{ adversary_id: "a1", name: "Lab Hunter" }]));
      if (req.method === "POST" && req.url === "/api/operations") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.statusCode = 201;
          res.end(JSON.stringify({ id: "op1" }));
        });
        return;
      }
      if (req.url === "/api/operations/op1") {
        return res.end(JSON.stringify({ state: "finished", chain: [{ ability: { technique_id: "T1082", name: "System Information Discovery" }, status: "0" }] }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
    const { adversaryCapability } = await import("../advsim/capability.js");
    const result = await runCampaign(
      { goal: "attck", authzId: null, targets: [labServer.url] },
      { dataRoot: tempRoot(), capabilities: [adversaryCapability({ base: labServer.url })], bridge: async () => ({ ok: false, exitCode: null, timedOut: false }) },
    );
    assert.ok(result.attckCoverage, "campaign carries ATT&CK coverage");
    assert.equal(result.attckCoverage!.executed[0]!.attackId, "T1082");
    const out = tempRoot();
    const report = buildRedReport(result, out);
    assert.ok(fs.readFileSync(report.markdownPath, "utf8").includes("T1082"));
  });
});

describe("lab callback integration", () => {
  it("an approved OOB command gadget is proven by the loopback listener", async () => {
    const callbackPort = 24777;
    const labServer = await lab(async (req, res) => {
      if (req.url === "/deserialize" && req.method === "POST") {
        // Lab target simulates the gadget's curl callback, nothing else.
        await fetch(`http://127.0.0.1:${callbackPort}/deser-oob`);
        res.end("accepted");
        return;
      }
      res.end("home");
    });
    const { deserCapability } = await import("../deser.js");
    const cap = deserCapability({ jar: "ysoserial.jar", oob: true, oobPort: callbackPort });
    const target = labServer.url;
    const ctx = { ...ctxFor(labServer.port), approval: () => true };
    const hyp = (await cap.hunt(target, { target, techFingerprint: [], webPaths: [] }, ctx))[0]!;
    const validation = await cap.validate(hyp, ctx);
    assert.equal(validation.status, "confirmed", validation.detail);
    assert.ok(validation.evidence.some((e) => e.kind === "poc" && /callback/i.test(e.observed ?? "")));
  });

  it("an OOB command gadget without approval is blocked before generation", async () => {
    const callbackPort = 24778;
    const labServer = await lab((_req, res) => res.end("home"));
    const { deserCapability } = await import("../deser.js");
    const cap = deserCapability({ jar: "ysoserial.jar", oob: true, oobPort: callbackPort });
    const ctx = ctxFor(labServer.port);
    const hyp = (await cap.hunt(labServer.url, { target: labServer.url, techFingerprint: [], webPaths: [] }, ctx))[0]!;
    const validation = await cap.validate(hyp, ctx);
    assert.equal(validation.status, "inconclusive");
    assert.match(validation.detail, /destructive action requires approval/);
  });
});

describe("real kill-switch control", () => {
  it("engages, audits and resets through the shared controller", async () => {
    const root = tempRoot();
    const { setRedKillSwitch } = await import("../control.js");
    let state = setRedKillSwitch(true, root);
    assert.equal(state.engaged, true);
    assert.equal(isKillSwitchEngaged(), true);
    const log = new RedAuditLog(root);
    assert.ok(log.read().some((a) => a.outcome === "killswitch_engaged"));
    state = setRedKillSwitch(false, root);
    assert.equal(state.engaged, false);
    assert.equal(isKillSwitchEngaged(), false);
  });

  it("the security page exposes the control wired to the API", () => {
    const root = path.resolve(process.cwd());
    const html = fs.readFileSync(path.join(root, "ui", "security.html"), "utf8");
    const js = fs.readFileSync(path.join(root, "ui", "security.js"), "utf8");
    assert.ok(html.includes('id="redKill"'), "kill-switch button exists in security.html");
    assert.ok(js.includes("/api/security/red/kill-switch"), "button is wired to the kill-switch endpoint");
  });
});
