/**
 * Regression tests for evidence correctness, engine output handling and reuse
 * of Loam's stronger OOB verification engines (P0/P1).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";

import { parseManifest } from "../../../bridges/manifestSchema.js";
import { toEnvelope } from "../../../bridges/envelope.js";
import type { BridgeEnvelope } from "../../../bridges/types.js";
import { fuzzCapability } from "../web/fuzz.js";
import { dastCapability } from "../web/dast.js";
import { ssrfCapability } from "../ssrf.js";
import { deserCapability } from "../deser.js";
import { templatesCapability } from "../templates.js";
import { runCampaign, type RedCapabilityContext, type RedHypothesis } from "../orchestrator/redOrchestrator.js";
import { RedAuditLog } from "../audit.js";
import { createAuthorizationRecord, killSwitchListenerCount } from "../gate.js";
import { redTransport } from "../transport.js";

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "loam-red-cap-review-"));
const TARGET = "http://127.0.0.1:3000/";
const servers: http.Server[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

async function lab(handler: http.RequestListener) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const port = (server.address() as import("node:net").AddressInfo).port;
  return { server, port, url: `http://127.0.0.1:${port}` };
}

function ctxWith(bridge: RedCapabilityContext["bridge"], extra: Partial<RedCapabilityContext> = {}): RedCapabilityContext {
  const authz = createAuthorizationRecord({
    statement: "lab",
    expiresInSeconds: 3600,
    scope: { allowHosts: ["127.0.0.1"], allowPorts: [], allowUrlPrefixes: [], denyAlways: [] },
  });
  return {
    authz,
    transport: redTransport(authz),
    bridge,
    audit: new RedAuditLog(tempRoot()),
    ...extra,
  };
}

const envelope = (ok: boolean, text = ""): BridgeEnvelope => ({ ok, exitCode: ok ? 0 : 1, timedOut: false, text, ...(ok ? {} : { error: { type: "x", message: text } }) });
const recon = { target: TARGET, techFingerprint: [], webPaths: [] };

describe("ffuf evidence semantics", () => {
  it("401/403 responses are not confirmed hidden-content findings", async () => {
    const ctx = ctxWith(async () => envelope(true, JSON.stringify({ results: [
      { input: { FUZZ: "admin" }, status: 401, length: 80, url: `${TARGET}admin` },
      { input: { FUZZ: "private" }, status: 403, length: 80, url: `${TARGET}private` },
    ] })));
    const cap = fuzzCapability();
    const hyp = (await cap.hunt(TARGET, recon, ctx))[0]!;
    const validation = await cap.validate(hyp, ctx);
    assert.notEqual(validation.status, "confirmed");
    assert.equal(validation.finding, undefined);
  });

  it("a 200 response with actual content remains a discovery finding", async () => {
    const ctx = ctxWith(async () => envelope(true, JSON.stringify({ results: [
      { input: { FUZZ: "backup" }, status: 200, length: 512, url: `${TARGET}backup` },
    ] })));
    const cap = fuzzCapability();
    const hyp = (await cap.hunt(TARGET, recon, ctx))[0]!;
    const validation = await cap.validate(hyp, ctx);
    assert.equal(validation.status, "confirmed");
    assert.equal(validation.finding!.check, "red_fuzz_discovery");
  });
});

describe("ZAP output files", () => {
  it("reads quickscan alerts from the workspace out-file", async () => {
    const workspace = tempRoot();
    fs.writeFileSync(path.join(workspace, "red-zap-report.json"), JSON.stringify({ site: { alerts: [
      { pluginid: "40018", name: "SQL Injection", riskcode: "3", uri: TARGET },
    ] } }));
    const ctx = ctxWith(async () => envelope(true, ""), { workspace });
    const cap = dastCapability();
    const hyp = (await cap.hunt(TARGET, recon, ctx))[0]!;
    const validation = await cap.validate(hyp, ctx);
    assert.equal(validation.status, "confirmed");
    assert.equal(validation.finding!.check, "red_zap_dast");
    assert.equal(validation.finding!.severity, "high");
  });
});

describe("SSRF structured probes and OOB reuse", () => {
  it("preserves the full payload instead of truncating it in the claim", async () => {
    let seen = "";
    const ctx = ctxWith(async () => envelope(false, "unused"), {
      transport: {
        request: async (url: string) => {
          seen = url;
          return { ok: false, status: 200, headers: {}, setCookie: [], body: "" };
        },
        evidence: [],
        count: 0,
      } as RedCapabilityContext["transport"],
    });
    const cap = ssrfCapability();
    const hypotheses = await cap.hunt(TARGET, recon, ctx);
    await cap.validate(hypotheses[1]!, ctx);
    assert.equal(decodeURIComponent(new URL(seen).searchParams.get("url")!), "http://169.254.169.254/latest/meta-data/iam/security-credentials/");
  });

  it("uses the existing OOB listener to prove SSRF with a negative baseline", async () => {
    const labServer = await lab(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname !== "/fetch") return res.end("home");
      const target = url.searchParams.get("url") ?? "";
      if (!/^https?:\/\//.test(target)) return res.end("home");
      try {
        const fetched = await fetch(target);
        res.statusCode = fetched.status;
        res.end(await fetched.text());
      } catch {
        res.statusCode = 502;
        res.end("fetch failed");
      }
    });
    const authz = createAuthorizationRecord({
      statement: "lab",
      expiresInSeconds: 3600,
      scope: { allowHosts: ["127.0.0.1"], allowPorts: [labServer.port], allowUrlPrefixes: [], denyAlways: [] },
    });
    const ctx: RedCapabilityContext = {
      authz,
      transport: redTransport(authz),
      bridge: async () => envelope(false, "unused"),
      audit: new RedAuditLog(tempRoot()),
    };
    const cap = ssrfCapability({ mode: "oob", path: "/fetch", field: "url", benignValue: "home" });
    const hyp = (await cap.hunt(labServer.url, { ...recon, target: labServer.url }, ctx))[0]!;
    const validation = await cap.validate(hyp, ctx);
    assert.equal(validation.status, "confirmed", validation.detail);
    assert.ok(validation.finding!.check.startsWith("ssrf_"));
    assert.ok(validation.evidence.some((e) => e.kind === "poc"));
  });

  it("the OOB path refutes a safe endpoint that never fetches user URLs", async () => {
    const labServer = await lab((_req, res) => res.end("home"));
    const authz = createAuthorizationRecord({
      statement: "lab",
      expiresInSeconds: 3600,
      scope: { allowHosts: ["127.0.0.1"], allowPorts: [labServer.port], allowUrlPrefixes: [], denyAlways: [] },
    });
    const ctx: RedCapabilityContext = { authz, transport: redTransport(authz), bridge: async () => envelope(false, "unused"), audit: new RedAuditLog(tempRoot()) };
    const cap = ssrfCapability({ mode: "oob", path: "/safe", field: "url", benignValue: "home" });
    const hyp = (await cap.hunt(labServer.url, { ...recon, target: labServer.url }, ctx))[0]!;
    const validation = await cap.validate(hyp, ctx);
    assert.equal(validation.status, "refuted");
  });
});

describe("deserialization binary integrity and OOB reuse", () => {
  it("accepts base64 bridge output without corrupting binary stdout", () => {
    const manifest = parseManifest({
      id: "binary-demo",
      name: "binary",
      description: "binary output",
      probe: { names: ["x"] },
      commands: [{ id: "gen", description: "gen", effect: "exec_script", argv: ["x"], params: {}, output: "base64" }],
    });
    assert.equal(manifest.ok, true);
    const env = toEnvelope(
      { output: "base64" },
      { code: 0, stdout: "", stdoutBuffer: Buffer.from([0xac, 0xed, 0x00, 0x05]), stderr: "", timedOut: false },
    );
    assert.equal(env.text, "rO0ABQ==");
  });

  it("delivers the exact deserialized bytes, not a base64 string", async () => {
    const expected = Buffer.from([0xac, 0xed, 0x00, 0x05]);
    let received = Buffer.alloc(0);
    const labServer = await lab((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        received = Buffer.concat(chunks);
        res.statusCode = 500;
        res.end("java.io.ObjectInputStream");
      });
    });
    const authz = createAuthorizationRecord({
      statement: "lab",
      expiresInSeconds: 3600,
      scope: { allowHosts: ["127.0.0.1"], allowPorts: [labServer.port], allowUrlPrefixes: [], denyAlways: [] },
    });
    const ctx: RedCapabilityContext = {
      authz,
      transport: redTransport(authz),
      bridge: async () => ({ ok: true, exitCode: 0, timedOut: false, text: expected.toString("base64") }),
      audit: new RedAuditLog(tempRoot()),
    };
    const cap = deserCapability({ jar: "ysoserial.jar" });
    const hyp = (await cap.hunt(labServer.url, { ...recon, target: labServer.url }, ctx))[0]!;
    const validation = await cap.validate(hyp, ctx);
    assert.equal(validation.status, "confirmed");
    assert.deepEqual(received, expected);
  });

  it("reuses the existing Node deserialization canary with a negative baseline", async () => {
    const labServer = await lab((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          const doc = JSON.parse(raw) as { data?: unknown };
          if (typeof doc.data === "string" && doc.data.startsWith("_$$ND_FUNC_$$_")) {
            const fn = doc.data.slice("_$$ND_FUNC_$$_".length);
            vm.runInNewContext(`(${fn})()`, { fetch });
          }
          res.end("accepted");
        } catch {
          res.statusCode = 400;
          res.end("bad serialized value");
        }
      });
    });
    const authz = createAuthorizationRecord({
      statement: "lab",
      expiresInSeconds: 3600,
      scope: { allowHosts: ["127.0.0.1"], allowPorts: [labServer.port], allowUrlPrefixes: [], denyAlways: [] },
    });
    const ctx: RedCapabilityContext = { authz, transport: redTransport(authz), bridge: async () => envelope(false, "unused"), audit: new RedAuditLog(tempRoot()) };
    const cap = deserCapability({ mode: "node" });
    const hyp = (await cap.hunt(labServer.url, { ...recon, target: labServer.url }, ctx))[0]!;
    const validation = await cap.validate(hyp, ctx);
    assert.equal(validation.status, "confirmed", validation.detail);
    assert.ok(validation.finding!.check.startsWith("deser_"));
    assert.equal(validation.finding!.severity, "critical");
  });
});

describe("nuclei severity and blue baseline", () => {
  it("unknown severities do not pass a high-only threshold", async () => {
    const ctx = ctxWith(async () => envelope(true, JSON.stringify({ "template-id": "mystery", "matched-at": TARGET, severity: "unknown" }) + "\n"));
    const cap = templatesCapability({ severity: "high" });
    const hyp = (await cap.hunt(TARGET, recon, ctx))[0]!;
    const validation = await cap.validate(hyp, ctx);
    assert.equal(validation.status, "refuted");
  });

  it("blue baseline runs even when red capabilities are present", async () => {
    const labServer = await lab((_req, res) => res.end("<html><title>baseline</title></html>"));
    const cap = {
      id: "red.empty",
      applicable: () => true,
      hunt: async (): Promise<RedHypothesis[]> => [],
      validate: async (hyp: RedHypothesis) => ({ hypothesisId: hyp.id, status: "refuted" as const, claim: hyp.claim, detail: "", evidence: [] }),
    };
    const result = await runCampaign(
      { goal: "baseline", authzId: null, targets: [labServer.url] },
      { dataRoot: tempRoot(), capabilities: [cap], bridge: async () => envelope(false, "unused") },
    );
    assert.ok(result.findings.some((f) => f.check === "security_headers"), "blue security_headers must still run");
  });
});

describe("kill-switch subscription lifecycle", () => {
  it("completed requests dispose their kill-switch listeners", async () => {
    const labServer = await lab((_req, res) => res.end("ok"));
    const authz = createAuthorizationRecord({
      statement: "lab",
      expiresInSeconds: 3600,
      scope: { allowHosts: ["127.0.0.1"], allowPorts: [labServer.port], allowUrlPrefixes: [], denyAlways: [] },
    });
    const transport = redTransport(authz);
    for (let i = 0; i < 3; i++) await transport.request(labServer.url);
    assert.equal(killSwitchListenerCount(), 0);
  });
});
