import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";

import { handleEngineRoute } from "../engineRoutes.js";
import { createAuthorizationRecord, saveAuthorization } from "../../security/red/gate.js";
import type { EnterpriseIdentity } from "../../security/enterprise/policy.js";

const servers: http.Server[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); delete process.env.LOAM_JADX_PATH; delete process.env.LOAM_JADX_SHA256; });
const identity: EnterpriseIdentity = { id: "admin-a", tenantIds: ["tenant-a"], roles: ["admin"], authMethod: "oidc" };

describe("engine worker HTTP", () => {
  it("lists sanitized manifests and runs an authorized pinned worker", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-engine-routes-"));
    const exe = path.join(root, "jadx.bin");
    const content = Buffer.from("pinned-jadx");
    fs.writeFileSync(exe, content);
    process.env.LOAM_JADX_PATH = exe;
    process.env.LOAM_JADX_SHA256 = createHash("sha256").update(content).digest("hex");
    const authz = createAuthorizationRecord({ root, statement: "engine HTTP lab", expiresInSeconds: 300, scope: { allowHosts: ["127.0.0.1"], allowPorts: [80], allowUrlPrefixes: [], denyAlways: [] } });
    saveAuthorization(authz, root);
    const server = http.createServer((req, res) => {
      void handleEngineRoute(req, res, new URL(req.url ?? "/", "http://127.0.0.1"), {
        workspace: root,
        dataRoot: root,
        identity: async () => identity,
        engineExec: async () => ({ code: 0, stdout: "decompiled", stderr: "", timedOut: false }),
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
    const list = await (await fetch(`${base}/api/security/engines`)).json() as { engines: Array<{ id: string; executableEnv?: string }> };
    assert.ok(list.engines.some((engine) => engine.id === "jadx"));
    assert.ok(!JSON.stringify(list).includes(exe));
    const response = await fetch(`${base}/api/security/engines/worker`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engineId: "jadx", commandId: "decompile", authorizationId: authz.id, scopeTarget: "http://127.0.0.1/", target: "app.apk", licenseReviewed: true }) });
    assert.equal(response.status, 200);
    const result = await response.json() as { result: { status: string } };
    assert.equal(result.result.status, "covered");
    const denied = await fetch(`${base}/api/security/engines/worker`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.test" }, body: "{}" });
    assert.equal(denied.status, 403);
  });
});
