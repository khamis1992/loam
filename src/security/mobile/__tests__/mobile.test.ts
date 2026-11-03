import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";

import { inspectMobileArtifact } from "../artifacts.js";
import { authorizeMobileEngagement, MobileEngagementStore, recordMobileRetest, recordMobileScan, reviewMobileFinding, reviewMobileQa, setMobileCoverage, transitionMobileEngagement } from "../engagement.js";
import { masvsSummary } from "../masvs.js";
import { MobSfClient, mobsfReportToIssues } from "../mobsfBridge.js";
import { buildMobileReport } from "../report.js";
import { AndroidDeviceWorker } from "../worker.js";

const tempRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "loam-mobile-"));
const servers: http.Server[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });

async function artifact(root: string) {
  fs.writeFileSync(path.join(root, "app.apk"), "authorized-apk-fixture");
  return inspectMobileArtifact(path.join(root, "app.apk"), root);
}

describe("mobile artifacts and MobSF", () => {
  it("hashes the exact artifact and scans it through the real HTTP contract", async () => {
    const root = tempRoot();
    const item = await artifact(root);
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/v1/upload") return res.end(JSON.stringify({ hash: "scan-hash" }));
      if (req.url === "/api/v1/scan") return res.end(JSON.stringify({ status: "ok" }));
      if (req.url === "/api/v1/report_json") return res.end(JSON.stringify({ mobsf_version: "test-1", findings: [{ title: "Insecure storage", severity: "high", description: "Sensitive data in private storage", file: "app.db" }] }));
      res.statusCode = 404;
      res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const client = new MobSfClient({ baseUrl: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`, apiKey: "test-key" });
    const result = await client.scan(item);
    assert.equal(result.status, "covered");
    assert.equal(result.findings[0]?.severity, "high");
    assert.equal(result.findings[0]?.target, "app.apk:app.db");
    assert.deepEqual(requests, ["POST /api/v1/upload", "POST /api/v1/scan", "POST /api/v1/report_json"]);
    assert.match(result.reportSha256 ?? "", /^[a-f0-9]{64}$/);
  });

  it("does not turn a MobSF failure into a clean result", async () => {
    const root = tempRoot();
    const item = await artifact(root);
    const client = new MobSfClient({ baseUrl: "http://127.0.0.1:1", apiKey: "test-key", timeoutMs: 100 });
    const result = await client.scan(item);
    assert.equal(result.status, "unavailable");
    assert.equal(result.findings.length, 0);
  });

  it("normalizes nested report issues and deduplicates them", () => {
    const issues = mobsfReportToIssues({ analysis: { items: [{ name: "Weak TLS", level: "medium", detail: "Old protocol" }] } });
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.severity, "medium");
  });
});

describe("MASVS engagement lifecycle", () => {
  it("enforces independent QA, complete coverage and critical retest", async () => {
    const root = tempRoot();
    const item = await artifact(root);
    const store = new MobileEngagementStore(root);
    const state = store.create({ tenantId: "tenant-a", ownerId: "analyst-a", artifacts: [item] });
    authorizeMobileEngagement(state, { id: "AUTHZ-1", statement: "authorized lab", expiresAt: new Date(Date.now() + 3600_000).toISOString(), approvedBy: "approver-a" });
    transitionMobileEngagement(state, "Running", "analyst-a");
    recordMobileScan(state, {
      artifact: item,
      status: "covered",
      engineVersion: "test-1",
      reportSha256: item.sha256,
      findings: [{ engine: "mobile", ruleId: "storage-1", severity: "critical", target: "app.apk:app.db", title: "Sensitive data exposed", detail: "fixture", remediation: "encrypt" }],
    });
    transitionMobileEngagement(state, "QA", "analyst-a");
    assert.throws(() => transitionMobileEngagement(state, "Delivered", "analyst-a"), /independent QA/);
    reviewMobileQa(state, "reviewer-a");
    reviewMobileFinding(state, state.findings[0]!.id, "reviewer-a");
    for (const coverage of state.coverage) setMobileCoverage(state, { ...coverage, status: "covered", applicable: true, reason: "reviewed fixture evidence", evidenceIds: ["EV-static"] }, "reviewer-a");
    assert.equal(masvsSummary(state.coverage).complete, true);
    transitionMobileEngagement(state, "Delivered", "reviewer-a");
    transitionMobileEngagement(state, "Retest", "analyst-a");
    assert.throws(() => transitionMobileEngagement(state, "Closed", "reviewer-a"), /fixed retest/);
    recordMobileRetest(state, state.findings[0]!.id, { status: "fixed", evidenceIds: ["EV-retest"], reviewerId: "reviewer-a", at: new Date().toISOString() });
    transitionMobileEngagement(state, "Closed", "reviewer-a");
    store.update(state);
    assert.equal(store.get("tenant-a", state.id).stage, "Closed");
    const report = buildMobileReport(state, path.join(root, "report"));
    assert.ok(fs.readFileSync(report.markdownPath, "utf8").includes("MASVS reviewed coverage: 100%"));
    assert.ok(fs.existsSync(report.sarifPath));
  });
});

describe("Android worker", () => {
  it("requires approval and captures bounded redacted evidence", async () => {
    const root = tempRoot();
    const item = await artifact(root);
    const calls: string[][] = [];
    const worker = new AndroidDeviceWorker({
      serial: "emulator-5554",
      packageName: "com.example.app",
      approved: true,
      exec: async (args) => {
        calls.push(args);
        const command = args[2];
        const stdout = command === "get-state" ? "device\n" : command === "logcat" ? "token=secret\n" : "Success\n";
        return { code: 0, stdout, stderr: "", timedOut: false };
      },
    });
    assert.equal((await worker.preflight()).status, "completed");
    const result = await worker.run(item);
    assert.equal(result.status, "completed");
    assert.ok(result.evidence[0]?.content.includes("[REDACTED]"));
    assert.ok(!result.evidence[0]?.content.includes("token=secret"));
    assert.ok(calls.every((args) => args[0] === "-s"));
    const denied = await new AndroidDeviceWorker({ serial: "emulator-5554", packageName: "com.example.app", approved: false }).preflight();
    assert.equal(denied.status, "unavailable");
    assert.match(denied.detail ?? "", /requires independent approval/);
  });
});
