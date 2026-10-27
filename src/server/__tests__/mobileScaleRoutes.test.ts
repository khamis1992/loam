import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";

import { handleMobileScaleRoute } from "../mobileScaleRoutes.js";
import { MobileEngagementStore } from "../../security/mobile/engagement.js";
import { inspectMobileArtifact } from "../../security/mobile/artifacts.js";
import { createAuthorizationRecord, saveAuthorization } from "../../security/red/gate.js";
import type { EnterpriseIdentity } from "../../security/enterprise/policy.js";

const servers: http.Server[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });

async function body(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const identity: EnterpriseIdentity = { id: "admin-a", tenantIds: ["tenant-a"], roles: ["admin"], authMethod: "oidc" };

describe("mobile scale HTTP", () => {
  it("runs devices, evidence, attack path, replay and SLO through real requests", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-scale-routes-"));
    fs.writeFileSync(path.join(root, "app.apk"), "fixture");
    const artifact = await inspectMobileArtifact(path.join(root, "app.apk"), root);
    const store = new MobileEngagementStore(path.join(root, ".loam", "mobile"));
    const engagement = store.create({ tenantId: "tenant-a", ownerId: "analyst-a", artifacts: [artifact] });
    const target = http.createServer((req, res) => res.end(JSON.stringify({ marker: req.headers.authorization === "owner" ? "private" : "public" })));
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    servers.push(target);
    const targetPort = (target.address() as import("node:net").AddressInfo).port;
    const authz = createAuthorizationRecord({ root, statement: "scale route replay", expiresInSeconds: 300, scope: { allowHosts: ["127.0.0.1"], allowPorts: [targetPort], allowUrlPrefixes: [], denyAlways: [] } });
    saveAuthorization(authz, root);
    engagement.authorization = { id: authz.id, statement: authz.authorization.statement, expiresAt: authz.authorization.expiresAt, approvedBy: "approver-a" };
    store.update(engagement);
    const server = http.createServer((req, res) => {
      void handleMobileScaleRoute(req, res, new URL(req.url ?? "/", "http://127.0.0.1"), {
        workspace: root,
        dataRoot: root,
        identity: async () => identity,
        readBody: body,
        sendJson: (response, status, value) => { const text = JSON.stringify(value); response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }); response.end(text); },
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    const call = async (pathSuffix: string, data: unknown) => {
      const response = await fetch(`${base}/api/security/mobile-scale${pathSuffix}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
      return { status: response.status, data: await response.json() as Record<string, unknown> };
    };
    const device = await call("/devices", { id: "android-e2e", platform: "android", osVersion: "15", capabilities: ["adb"], workerVersion: "1.0.0", imageDigest: `sha256:${"a".repeat(64)}` });
    assert.equal(device.status, 201);
    const leased = await call("/devices/lease", { engagementId: engagement.id, platform: "android", capabilities: ["adb"] });
    assert.equal(leased.status, 200);
    const second = await call("/devices/lease", { engagementId: engagement.id, platform: "android" });
    assert.equal(second.status, 503);
    const event = await call(`/timeline/${engagement.id}`, { kind: "request", summary: "E2E request", content: "token=secret" });
    assert.equal(event.status, 201);
    const eventId = (event.data.event as { id: string }).id;
    const investigation = await (await fetch(`${base}/api/security/mobile-scale/investigation/${engagement.id}`)).json() as { unlinkedEvidence: number };
    assert.equal(investigation.unlinkedEvidence, 1);
    const paths = await call(`/attack-path/${engagement.id}`, {
      nodes: [{ id: "app", kind: "application", label: "App" }, { id: "data", kind: "data", label: "Records", sensitive: true }],
      edges: [{ from: "app", to: "data", action: "read", evidenceIds: [eventId] }],
    });
    assert.equal(paths.status, 200);
    const replay = await call(`/replay/${engagement.id}`, { url: `http://127.0.0.1:${targetPort}/record`, headers: { authorization: "owner" }, expectedStatus: 200, expectedMarker: "private" });
    assert.equal(replay.status, 200);
    const slo = await (await fetch(`${base}/api/security/mobile-scale/slo`)).json() as { queueWaitMeasured: boolean };
    assert.equal(slo.queueWaitMeasured, false);
    const released = await call(`/devices/android-e2e/release`, { engagementId: engagement.id, success: false, evidenceSha256: "b".repeat(64) });
    assert.equal(released.status, 200);
    assert.equal((released.data.device as { health: string }).health, "quarantined");
  });
});
