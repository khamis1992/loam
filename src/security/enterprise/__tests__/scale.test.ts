import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";

import { createDrBackup, restoreDrBackup } from "../dr.js";
import { canCloseRemediation, GitHubIntegration, IntegrationDedupeStore, JiraIntegration, SlackIntegration, validateRemediation } from "../integrations.js";
import { evaluateSlo } from "../slo.js";

const servers: http.Server[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });

describe("developer integrations", () => {
  it("delivers Jira, GitHub and Slack through real HTTP without duplicate claims", async () => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("jira")) return res.end(JSON.stringify({ id: "100", key: "SEC-1" }));
      if (req.url?.includes("repos")) return res.end(JSON.stringify({ id: 200, number: 2 }));
      res.end("ok");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    const jira = new JiraIntegration({ baseUrl: `${base}/jira`, project: "SEC", token: "secret", allowedHosts: [] });
    const github = new GitHubIntegration({ baseUrl: base, owner: "loam", repo: "security", token: "secret" });
    const slack = new SlackIntegration({ webhookUrl: `${base}/slack` });
    assert.equal((await jira.createFinding({ findingId: "F1", title: "Finding", description: "detail" })).reference, "SEC-1");
    assert.equal((await github.createFinding({ findingId: "F1", title: "Finding", description: "detail" })).reference, "2");
    await slack.notify("Security update");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-integration-dedupe-"));
    const dedupe = new IntegrationDedupeStore(root);
    assert.equal(dedupe.claim("tenant-a", "F1", "jira"), true);
    assert.equal(dedupe.claim("tenant-a", "F1", "jira"), false);
    assert.equal(dedupe.claim("tenant-b", "F1", "jira"), true);
    assert.equal(seen.length, 3);
    const ticket = { findingId: "F1", owner: "dev-a", slaDueAt: new Date(Date.now() + 86_400_000).toISOString(), retestStatus: "fixed" as const };
    assert.equal(canCloseRemediation(ticket), true);
    assert.throws(() => validateRemediation({ ...ticket, acceptanceExpiresAt: new Date(Date.now() - 1000).toISOString(), retestStatus: "persistent" }), /fixed retest/);
  });
});

describe("SLO and disaster recovery", () => {
  it("alerts on reliability and coverage failures", () => {
    const result = evaluateSlo([{ status: "completed", queueWaitMs: 100 }, { status: "dead", queueWaitMs: 400_000 }], 1, 1);
    assert.equal(result.successRate, 0.5);
    assert.ok(result.alerts.length >= 3);
  });

  it("restores only signed, hash-verified backup content", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-dr-"));
    const source = path.join(root, "source");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "state.sqlite"), "sqlite-fixture");
    const key = randomBytes(32);
    const manifest = createDrBackup(source, path.join(root, "backup"), key, key);
    assert.ok(fs.existsSync(manifest));
    assert.ok(!fs.readFileSync(path.join(root, "backup", "files", "state.sqlite"), "utf8").includes("sqlite-fixture"));
    restoreDrBackup(path.join(root, "backup"), path.join(root, "restore"), key, key);
    assert.equal(fs.readFileSync(path.join(root, "restore", "state.sqlite"), "utf8"), "sqlite-fixture");
    fs.appendFileSync(path.join(root, "backup", "files", "state.sqlite"), "tamper");
    assert.throws(() => restoreDrBackup(path.join(root, "backup"), path.join(root, "restore-2"), key, key), /content mismatch/);
  });
});
