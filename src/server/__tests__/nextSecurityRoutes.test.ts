import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";

import { handleNextSecurityRoute } from "../nextSecurityRoutes.js";
import type { EnterpriseIdentity } from "../../security/enterprise/policy.js";

const servers: http.Server[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });
const identity: EnterpriseIdentity = { id: "admin-a", tenantIds: ["tenant-a"], roles: ["admin"], authMethod: "oidc" };

describe("next-generation security HTTP", () => {
  it("runs atomic, agentic, CBOM, channels and provenance contracts", async () => {
    const server = http.createServer((req, res) => {
      void handleNextSecurityRoute(req, res, new URL(req.url ?? "/", "http://127.0.0.1"), {
        workspace: os.tmpdir(),
        identity: async () => identity,
        readBody: async (request) => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(chunk as Buffer);
          return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        },
        sendJson: (response, status, value) => { const text = JSON.stringify(value); response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }); response.end(text); },
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    const call = async (area: string, body: unknown) => {
      const response = await fetch(`${base}/api/security/next/${area}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() as Record<string, unknown> };
    };
    const test = { id: "atomic-api", controlId: "MASVS-AUTH-1", title: "Atomic API", method: "automated", standard: "MASVS", standardVersion: "2.0", ruleVersion: "1.0", negativeControl: "safe", evidenceRequired: ["request"] };
    const atomic = await call("atomic", { test, observation: { positiveControl: true, negativeControl: true, evidenceIds: ["EV1"] } });
    assert.equal(atomic.status, 200);
    const agentic = await call("agentic", { event: { kind: "tool", tool: "shell.exec", allowedTools: ["http.get"] } });
    assert.equal((agentic.data.findings as Array<{ category: string }>)[0]?.category, "tool-abuse");
    const cbom = await call("cbom", { assets: [{ name: "rsa", kind: "key", algorithm: "RSA" }] });
    assert.equal((cbom.data.bom as { specVersion: string }).specVersion, "1.7");
    const channels = await call("channels", { observations: [
      { operation: "read", channel: "REST", authenticated: true, authorized: true, status: 200, evidenceIds: ["EV1"] },
      { operation: "read", channel: "gRPC", authenticated: true, authorized: false, status: 200, evidenceIds: ["EV2"] },
    ] });
    assert.equal((channels.data.results as Array<{ status: string }>)[0]?.status, "finding");
    const key = randomBytes(32);
    process.env.LOAM_PROVENANCE_KEY = key.toString("base64");
    const source = Buffer.from("source");
    const signed = await call("provenance", { action: "sign", provenance: { version: "slsa-1.2", buildType: "test", builderId: "builder", source: { uri: "src/app", digestSha256: createHash("sha256").update(source).digest("hex") }, materials: [] } });
    assert.equal(signed.status, 201);
    const verified = await call("provenance", { action: "verify", provenance: signed.data.provenance, artifacts: { "src/app": source.toString("base64") } });
    assert.equal(verified.status, 200);
    assert.equal((verified.data.local as { valid: boolean }).valid, true);
    delete process.env.LOAM_PROVENANCE_KEY;
  });
});
