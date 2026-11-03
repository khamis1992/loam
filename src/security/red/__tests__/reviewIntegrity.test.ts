/**
 * P1 integrity tests: streaming bounds, recursive redaction, signed/tamper-
 * evident authorization records and hash-chained audit history.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";

import { createAuthorizationRecord, loadAuthorization, saveAuthorization } from "../gate.js";
import { RedAuditLog, redactParams } from "../audit.js";
import { redTransport } from "../transport.js";
import { buildRedReport } from "../report.js";
import { enrichFinding } from "../../findings.js";
import type { RedCampaignResult } from "../orchestrator/redOrchestrator.js";

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "loam-red-integrity-"));
const servers: http.Server[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

describe("response streaming", () => {
  it("caps the body while reading instead of consuming the whole stream", async () => {
    const originalFetch = globalThis.fetch;
    let produced = 0;
    const total = 64 * 1024;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (produced >= total) {
              controller.close();
              return;
            }
            produced += 1024;
            controller.enqueue(new Uint8Array(1024));
          },
        }),
        { status: 200 },
      );
    try {
      const transport = redTransport(null, { maxBodyBytes: 16 });
      const result = await transport.request("http://127.0.0.1/large");
      assert.equal(result.body.length, 16);
      assert.equal(result.bodyTruncated, true);
      assert.ok(produced < total, `stream was fully consumed (${produced} bytes)`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("recursive and evidence redaction", () => {
  it("redacts nested params, bearer values and URL userinfo", () => {
    const out = redactParams({
      nested: { cookie: "session=abc123", inner: { token: "t0k3n" } },
      note: "Bearer abc.def.ghi",
      url: "http://user:pass@127.0.0.1/",
    });
    const serialized = JSON.stringify(out);
    assert.ok(!serialized.includes("abc123"));
    assert.ok(!serialized.includes("t0k3n"));
    assert.ok(!serialized.includes("abc.def.ghi"));
    assert.ok(!serialized.includes("pass"));
  });

  it("redacts request/response secrets before evidence is returned or stored", async () => {
    const server = http.createServer((_req, res) => res.end("password=supersecret"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const port = (server.address() as import("node:net").AddressInfo).port;
    const transport = redTransport(null);
    const result = await transport.request(`http://127.0.0.1:${port}/`, {
      method: "POST",
      body: "password=supersecret",
      headers: { authorization: "Bearer supersecret" },
    });
    assert.ok(!result.body.includes("supersecret"));
    assert.ok(!transport.evidence[0]!.requestBody!.includes("supersecret"));
    assert.ok(!transport.evidence[0]!.url.includes("supersecret"));
  });

  it("PoC artifacts never include raw secrets", () => {
    const out = tempRoot();
    const result: RedCampaignResult = {
      campaignId: "RED-secret",
      authzId: null,
      findings: [enrichFinding({ id: "F1", check: "red_x", verdict: "finding", severity: "high", title: "secret", target: "http://127.0.0.1/", detail: "password=supersecret" }, ["EV0001"])],
      unverified: [],
      evidence: [{ id: "EV0001", kind: "poc", at: new Date().toISOString(), poc: "POST /login", observed: "password=supersecret" }],
      requestEvidence: [],
      audit: [],
      ptt: { id: "PTT1", goal: "g", status: "doing", children: [], evidenceIds: [] },
      coverage: [],
      coverageEntries: [],
      stats: { startedAt: "", finishedAt: "", requestsSent: 0, targetsProcessed: 0, killed: false, aborted: null },
    };
    const report = buildRedReport(result, out);
    const artifact = fs.readFileSync(report.poc[0]!.artifactPath, "utf8");
    assert.ok(!artifact.includes("supersecret"));
  });
});

describe("signed authorization records", () => {
  it("allocates ids from persisted records and detects tampering", () => {
    const root = tempRoot();
    const first = createAuthorizationRecord({
      root,
      statement: "first",
      expiresInSeconds: 3600,
      scope: { allowHosts: ["127.0.0.1"], allowPorts: [], allowUrlPrefixes: [], denyAlways: [] },
    });
    assert.equal(first.id, "AUTHZ-0001");
    saveAuthorization(first, root);
    const second = createAuthorizationRecord({
      root,
      statement: "second",
      expiresInSeconds: 3600,
      scope: { allowHosts: ["127.0.0.1"], allowPorts: [], allowUrlPrefixes: [], denyAlways: [] },
    });
    assert.equal(second.id, "AUTHZ-0002");
    saveAuthorization(second, root);

    const loaded = loadAuthorization(first.id, root);
    assert.ok(loaded);
    assert.ok(loaded.signature && loaded.signature.length >= 32, "saved records are signed");

    const file = path.join(root, "authz", `${first.id}.json`);
    const tampered = JSON.parse(fs.readFileSync(file, "utf8")) as { scope: { allowHosts: string[] } };
    tampered.scope.allowHosts.push("8.8.8.8");
    fs.writeFileSync(file, JSON.stringify(tampered, null, 2));
    assert.equal(loadAuthorization(first.id, root), null, "tampered scope must be rejected");
  });
});

describe("hash-chained audit history", () => {
  it("verifies a clean chain and rejects an edited entry", () => {
    const root = tempRoot();
    const log = new RedAuditLog(root);
    log.append({ authzId: null, capability: "c", action: "a", target: "t1", params: {}, outcome: "allowed" });
    log.append({ authzId: null, capability: "c", action: "a", target: "t2", params: {}, outcome: "denied" });
    assert.equal(log.verify(), true);

    const file = path.join(root, "audit", "red-audit.jsonl");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    const edited = JSON.parse(lines[1]!) as { target: string };
    edited.target = "tampered-target";
    lines[1] = JSON.stringify(edited);
    fs.writeFileSync(file, lines.join("\n") + "\n");
    assert.equal(log.verify(), false);
  });
});
