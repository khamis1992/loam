import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";

import { runScanners } from "../../audit/scanners.js";
import { createAuthorizationRecord, loadAuthorization } from "../gate.js";
import { runCampaign, type RedCapability } from "../orchestrator/redOrchestrator.js";
import { redTransport } from "../transport.js";

const tempRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "loam-red-hardening-"));
const servers: http.Server[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });

async function lab(handler: http.RequestListener): Promise<{ url: string; port: number }> {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const port = (server.address() as import("node:net").AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/`, port };
}

describe("enterprise authorization hardening", () => {
  it("rejects unsigned authorization records", () => {
    const root = tempRoot();
    const rec = createAuthorizationRecord({
      root,
      statement: "signed authorization required",
      expiresInSeconds: 60,
      scope: { allowHosts: ["example.test"], allowPorts: [443], allowUrlPrefixes: [], denyAlways: [] },
    });
    fs.mkdirSync(path.join(root, "authz"), { recursive: true });
    fs.writeFileSync(path.join(root, "authz", `${rec.id}.json`), JSON.stringify(rec));
    assert.equal(loadAuthorization(rec.id, root), null);
  });

  it("never forwards campaign credentials to another origin", async () => {
    let firstAuth: string | undefined;
    let secondAuth: string | undefined;
    const first = await lab((req, res) => { firstAuth = req.headers.authorization; res.end("ok"); });
    const second = await lab((req, res) => { secondAuth = req.headers.authorization; res.end("ok"); });
    const authz = createAuthorizationRecord({
      statement: "two local test origins",
      expiresInSeconds: 60,
      scope: { allowHosts: ["127.0.0.1"], allowPorts: [first.port, second.port], allowUrlPrefixes: [], denyAlways: [] },
    });
    const transport = redTransport(authz, { authHeaders: { authorization: "Bearer test-secret" }, authOrigin: first.url });
    await transport.request(first.url);
    await transport.request(second.url);
    assert.equal(firstAuth, "Bearer test-secret");
    assert.equal(secondAuth, undefined);
  });

  it("does not mark a failed capability as covered", async () => {
    const target = await lab((_req, res) => res.end("ok"));
    const capability: RedCapability = {
      id: "red.failure",
      applicable: () => true,
      hunt: async () => { throw new Error("engine crashed"); },
      validate: async (hyp) => ({ hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: "not run", evidence: [] }),
    };
    const result = await runCampaign(
      { goal: "coverage integrity", authzId: null, targets: [target.url] },
      { dataRoot: tempRoot(), capabilities: [capability] },
    );
    assert.equal(result.coverageEntries.find((e) => e.capability === capability.id)?.status, "error");
    assert.ok(!result.coverage.some((key) => key.includes("red_failure")));
  });

  it("treats missing scanner SARIF as a tool error, not a clean scan", async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, "sample.apk"), "fixture");
    const result = await runScanners({
      target: root,
      scratch: path.join(root, "scratch"),
      tools: ["mobsf"],
      exec: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
    });
    assert.equal(result.reports[0]?.status, "tool_error");
    assert.match(result.reports[0]?.detail ?? "", /no SARIF output/);
  });
});
