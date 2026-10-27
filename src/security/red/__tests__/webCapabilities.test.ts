/**
 * Bridge-driven web capability tests (RED_TEAM_BUILD_SPEC §6.3, §6.5, §6.6).
 * Engines are stubbed through the BridgeCaller; parsers get real fixtures.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { BridgeEnvelope } from "../../../bridges/types.js";
import { RedAuditLog } from "../audit.js";
import { createAuthorizationRecord, type AuthorizationRecord } from "../gate.js";
import { redTransport, type RedTransport } from "../transport.js";
import type { RedCapabilityContext, RedHypothesis } from "../orchestrator/redOrchestrator.js";
import { parseSqlmap, sqliCapability } from "../web/sqli.js";
import { parseZapAlerts, dastCapability } from "../web/dast.js";
import { parseFfuf, fuzzCapability } from "../web/fuzz.js";
import { parseNuclei, templatesCapability, selectTemplateTags } from "../templates.js";

const TARGET = "http://127.0.0.1:3000/item?id=1";

const ctxWith = (bridge: (id: string, cmd: string, args: Record<string, unknown>) => Promise<BridgeEnvelope>): RedCapabilityContext => {
  const authz: AuthorizationRecord = createAuthorizationRecord({
    statement: "lab",
    expiresInSeconds: 3600,
    scope: { allowHosts: ["127.0.0.1"], allowPorts: [3000], allowUrlPrefixes: [], denyAlways: [] },
  });
  const transport: RedTransport = redTransport(authz);
  return { authz, transport, bridge, audit: new RedAuditLog(fs.mkdtempSync(path.join(os.tmpdir(), "red-test-audit-"))) };
};

const envelope = (ok: boolean, text: string): BridgeEnvelope => ({
  ok, exitCode: ok ? 0 : 1, timedOut: false, text, ...(ok ? {} : { error: { type: "probe", message: text } }),
});

describe("parsers", () => {
  it("parseSqlmap extracts injectability, parameters and DBMS", () => {
    const proof = parseSqlmap([
      "[INFO] testing 'AND boolean-based blind'",
      "Parameter: 'id'",
      "    Type: boolean-based blind",
      "Payload: id=1' AND 7370=7370-- -",
      "[INFO] the back-end DBMS is MySQL",
      "back-end DBMS: MySQL >= 5.0.0",
      "is vulnerable: true",
    ].join("\n"));
    assert.equal(proof.injectable, true);
    assert.deepEqual(proof.parameters, ["'id'"]);
    assert.match(proof.dbms ?? "", /MySQL/);
  });

  it("parseZapAlerts reads both JSON and XML shapes", () => {
    const json = JSON.stringify({ site: { alerts: [{ pluginid: "10038", name: "Content Security Policy", riskcode: "2", uri: "http://t/" }] } });
    let alerts = parseZapAlerts(json);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.name, "Content Security Policy");
    const xml = `<OWASPZAPReport version="2"><site><alerts><alertitem><pluginid>40018</pluginid><name>SQL Injection</name><riskcode>3</riskcode><uri>http://t/?id=1</uri></alertitem></alerts></site></OWASPZAPReport>`;
    alerts = parseZapAlerts(xml);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.riskcode, "3");
    assert.deepEqual(parseZapAlerts("garbage"), []);
  });

  it("parseFfuf reads results with FUZZ inputs", () => {
    const hits = parseFfuf(JSON.stringify({ results: [
      { input: { FUZZ: "admin" }, status: 200, length: 512, url: "http://t/admin" },
      { input: { FUZZ: "nope" }, status: 404, length: 0, url: "http://t/nope" },
    ] }));
    assert.equal(hits.length, 2);
    assert.equal(hits[0]!.input, "admin");
  });

  it("parseNuclei reads jsonl lines", () => {
    const raw = [
      JSON.stringify({ "template-id": "CVE-2024-4577", "matched-at": "http://t/x", severity: "critical", name: "PHP CGI" }),
      "not json",
      JSON.stringify({ "template-id": "tech-detect", "matched-at": "http://t/", severity: "info" }),
    ].join("\n");
    const hits = parseNuclei(raw);
    assert.equal(hits.length, 2);
    assert.equal(hits[0]!.templateId, "CVE-2024-4577");
  });
});

describe("sqli capability", () => {
  it("a vulnerable sqlmap run becomes a PoC-backed high finding", async () => {
    let seen: Record<string, unknown> = {};
    const ctx = ctxWith(async (_id, cmd, args) => {
      seen = { cmd, ...args };
      return envelope(true, "Parameter: 'id'\nback-end DBMS: MySQL\nis vulnerable: true");
    });
    const cap = sqliCapability({ scriptPath: "sqlmap.py" });
    const hyps = await cap.hunt(TARGET, { target: TARGET, techFingerprint: [], webPaths: [] }, ctx);
    assert.equal(hyps.length, 1);
    const v = await cap.validate(hyps[0]!, ctx);
    assert.equal(seen.cmd, "test");
    assert.equal((seen as { url?: string }).url, TARGET);
    assert.equal((seen as { script?: string }).script, "sqlmap.py");
    assert.equal(v.status, "confirmed");
    assert.equal(v.finding!.check, "red_sqli");
    assert.equal(v.finding!.severity, "high");
    assert.ok(v.evidence.some((e) => e.kind === "poc" && e.observed!.includes("'id'")));
  });

  it("a missing engine is inconclusive, never a finding; a clean run is refuted", async () => {
    const ctx = ctxWith(async () => envelope(false, "engine not found"));
    const cap = sqliCapability({ scriptPath: "sqlmap.py" });
    const hyp = (await cap.hunt(TARGET, { target: TARGET, techFingerprint: [], webPaths: [] }, ctx))[0]!;
    assert.equal((await cap.validate(hyp, ctx)).status, "inconclusive");
    const clean = ctxWith(async () => envelope(true, "no injectable parameter found"));
    assert.equal((await cap.validate(hyp, clean)).status, "refuted");
    const noScript = ctxWith(async () => { throw new Error("must not call the bridge without a script"); });
    assert.equal((await sqliCapability({ scriptPath: null }).validate(hyp, noScript)).status, "inconclusive");
  });
});

describe("dast capability", () => {
  it("ZAP alerts become findings with the most severe representing the claim", async () => {
    const ctx = ctxWith(async () => envelope(true, JSON.stringify({ site: { alerts: [
      { pluginid: "10038", name: "CSP Missing", riskcode: "2", uri: TARGET },
      { pluginid: "40018", name: "SQL Injection", riskcode: "3", uri: TARGET },
    ] } })));
    const cap = dastCapability();
    const hyp = (await cap.hunt(TARGET, { target: TARGET, techFingerprint: [], webPaths: [] }, ctx))[0]!;
    const v = await cap.validate(hyp, ctx);
    assert.equal(v.status, "confirmed");
    assert.equal(v.finding!.severity, "high");
    assert.equal(v.evidence.length, 2);
  });
});

describe("fuzz capability", () => {
  it("responding hidden paths become a discovery finding", async () => {
    const ctx = ctxWith(async () => envelope(true, JSON.stringify({ results: [
      { input: { FUZZ: "admin" }, status: 200, length: 512, url: "http://t/admin" },
      { input: { FUZZ: "missing" }, status: 404, length: 0, url: "http://t/missing" },
    ] })));
    const cap = fuzzCapability();
    const hyp = (await cap.hunt(TARGET, { target: TARGET, techFingerprint: [], webPaths: [] }, ctx))[0]!;
    const v = await cap.validate(hyp, ctx);
    assert.equal(v.status, "confirmed");
    assert.equal(v.finding!.check, "red_fuzz_discovery");
    assert.ok(v.finding!.detail.includes("/admin"));
    assert.ok(!v.finding!.detail.includes("/missing"));
  });
});

describe("templates capability", () => {
  it("nuclei hits become severity-ranked findings; severity threshold filters", async () => {
    const ctx = ctxWith(async () => envelope(true, [
      JSON.stringify({ "template-id": "CVE-2024-4577", "matched-at": TARGET, severity: "critical", name: "PHP CGI Arg Injection" }),
      JSON.stringify({ "template-id": "tech-detect", "matched-at": TARGET, severity: "info" }),
    ].join("\n")));
    const cap = templatesCapability({ severity: "medium" });
    const hyp = (await cap.hunt(TARGET, { target: TARGET, techFingerprint: [], webPaths: [] }, ctx))[0]!;
    const v = await cap.validate(hyp, ctx);
    assert.equal(v.status, "confirmed");
    assert.equal(v.finding!.severity, "critical");
    assert.equal(v.finding!.check, "red_nuclei_template");
    // info hits are below the requested severity and must not appear as evidence
    assert.equal(v.evidence.length, 1);
  });

  it("selectTemplateTags narrows recon leads", () => {
    assert.deepEqual(
      selectTemplateTags([{ cveId: "CVE-2024-4577", source: "fingerprint", reason: "r" }, { cveId: "CVE-2024-4577", source: "kev", reason: "r2" }]),
      ["cve-2024-4577"],
    );
  });
});
