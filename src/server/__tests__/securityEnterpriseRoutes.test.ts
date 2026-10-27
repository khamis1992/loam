import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";

import { handleSecurityEnterpriseRoute } from "../securityEnterpriseRoutes.js";
import { configureSharedKillState, resetKillSwitch } from "../../security/red/gate.js";
import type { EnterpriseIdentity } from "../../security/enterprise/policy.js";

const servers: http.Server[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); configureSharedKillState(undefined); resetKillSwitch(); });

async function readBody(req: http.IncomingMessage, maxBytes = 100_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function routeLab(workspace: string, dataRoot: string, identity: EnterpriseIdentity) {
  const server = http.createServer((req, res) => {
    void handleSecurityEnterpriseRoute(req, res, new URL(req.url ?? "/", "http://127.0.0.1"), {
      workspace,
      dataRoot,
      identity: async (request) => request.headers["x-test-user"] === "reviewer" ? admin(identity.tenantIds[0]!, "reviewer-a") : identity,
      readBody,
      sendJson: (response, status, body) => {
        const text = JSON.stringify(body);
        response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        response.end(text);
      },
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
}

const admin = (tenantId: string, id = "admin-a"): EnterpriseIdentity => ({ id, tenantIds: [tenantId], roles: ["admin"], authMethod: "oidc" });

describe("enterprise security HTTP routes", () => {
  it("runs create-authorize-start with real requests and hides local paths", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-enterprise-http-"));
    fs.writeFileSync(path.join(root, "app.apk"), "fixture");
    const base = await routeLab(root, path.join(root, "shared"), admin("tenant-a"));
    const created = await fetch(`${base}/api/security/enterprise/engagements`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(created.status, 201);
    const body = await created.json() as { engagement: { id: string; artifacts: Array<{ path: string }> } };
    assert.equal(body.engagement.artifacts[0]?.path, "");
    const id = body.engagement.id;
    const authorized = await fetch(`${base}/api/security/enterprise/engagements/${id}/authorize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ authorizationId: "AUTHZ-1", statement: "authorized test", expiresAt: new Date(Date.now() + 3600_000).toISOString() }) });
    assert.equal(authorized.status, 200);
    const started = await fetch(`${base}/api/security/enterprise/engagements/${id}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(started.status, 200);
    const state = await (await fetch(`${base}/api/security/enterprise/engagements/${id}/status`)).json() as { engagement: { stage: string } };
    assert.equal(state.engagement.stage, "Running");
  });

  it("denies cross-tenant access and cross-site writes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-enterprise-http-"));
    fs.writeFileSync(path.join(root, "app.apk"), "fixture");
    const base = await routeLab(root, path.join(root, "shared"), admin("tenant-b", "admin-b"));
    const denied = await fetch(`${base}/api/security/enterprise/engagements?tenantId=tenant-a`);
    assert.equal(denied.status, 403);
    const crossSite = await fetch(`${base}/api/security/enterprise/engagements`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.test", "sec-fetch-site": "cross-site" }, body: "{}" });
    assert.equal(crossSite.status, 403);
  });

  it("shares the persistent kill state with the red gate", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-enterprise-http-"));
    const base = await routeLab(root, path.join(root, "shared"), admin("tenant-a"));
    const response = await fetch(`${base}/api/security/enterprise/kill-switch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engage: true, ttlSeconds: 60 }) });
    assert.equal(response.status, 200);
    const { gate } = await import("../../security/red/gate.js");
    assert.equal(gate("http://127.0.0.1/", { capability: "red.test", verb: "read" }, null).reason, "kill-switch engaged");
  });

  it("completes scan, MASVS review, QA, delivery, retest and closure through real HTTP", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-enterprise-http-e2e-"));
    fs.writeFileSync(path.join(root, "app.apk"), "fixture");
    const mobsf = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/v1/upload") return res.end(JSON.stringify({ hash: "e2e-scan" }));
      if (req.url === "/api/v1/scan") return res.end(JSON.stringify({ status: "ok" }));
      if (req.url === "/api/v1/report_json") return res.end(JSON.stringify({ mobsf_version: "e2e", findings: [] }));
      res.statusCode = 404;
      res.end("{}");
    });
    mobsf.listen(0, "127.0.0.1");
    await once(mobsf, "listening");
    servers.push(mobsf);
    process.env.LOAM_MOBSF_URL = `http://127.0.0.1:${(mobsf.address() as import("node:net").AddressInfo).port}`;
    process.env.LOAM_MOBSF_API_KEY = "test-key";
    const base = await routeLab(root, path.join(root, "shared"), admin("tenant-a"));
    const call = async (pathSuffix: string, body: unknown = {}, reviewer = false) => {
      const response = await fetch(`${base}/api/security/enterprise${pathSuffix}`, { method: "POST", headers: { "content-type": "application/json", ...(reviewer ? { "x-test-user": "reviewer" } : {}) }, body: JSON.stringify(body) });
      const data = await response.json() as { error?: string; engagement?: { id: string; stage: string; coverage: Array<{ controlId: string }> } };
      assert.equal(response.status, 200, data.error);
      return data;
    };
    try {
      const created = await fetch(`${base}/api/security/enterprise/engagements`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const createdBody = await created.json() as { engagement: { id: string } };
      const id = createdBody.engagement.id;
      await call(`/engagements/${id}/authorize`, { authorizationId: "AUTHZ-E2E", statement: "full local acceptance", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
      await call(`/engagements/${id}/start`);
      await call(`/engagements/${id}/scan`);
      await call(`/engagements/${id}/submit-qa`);
      await call(`/engagements/${id}/qa`, {}, true);
      const state = await (await fetch(`${base}/api/security/enterprise/engagements/${id}/status`)).json() as { engagement: { coverage: Array<{ controlId: string }> } };
      for (const control of state.engagement.coverage) await call(`/engagements/${id}/coverage`, { controlId: control.controlId, status: "covered", applicable: true, reason: "reviewed E2E evidence", evidenceIds: ["EV-E2E"] }, true);
      await call(`/engagements/${id}/deliver`, {}, true);
      await call(`/engagements/${id}/start-retest`);
      const closed = await call(`/engagements/${id}/close`, {}, true);
      assert.equal(closed.engagement?.stage, "Closed");
      const report = await fetch(`${base}/api/security/enterprise/engagements/${id}/report`);
      const document = await report.json() as { content: string };
      assert.ok(document.content.includes("MASVS reviewed coverage: 100%"));
    } finally {
      delete process.env.LOAM_MOBSF_URL;
      delete process.env.LOAM_MOBSF_API_KEY;
    }
  });
});
