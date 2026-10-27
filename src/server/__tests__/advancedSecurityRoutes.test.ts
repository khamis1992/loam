import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";

import { handleAdvancedSecurityRoute } from "../advancedSecurityRoutes.js";
import { MobileEngagementStore } from "../../security/mobile/engagement.js";
import { inspectMobileArtifact } from "../../security/mobile/artifacts.js";
import { createAuthorizationRecord, saveAuthorization } from "../../security/red/gate.js";
import { signPlugin } from "../../security/plugins.js";
import type { EnterpriseIdentity } from "../../security/enterprise/policy.js";

const servers: http.Server[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });
const identity: EnterpriseIdentity = { id: "admin-a", tenantIds: ["tenant-a"], roles: ["admin"], authMethod: "oidc" };

async function body(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

describe("advanced security HTTP", () => {
  it("runs GraphQL, instrumentation, signed plugins and unified coverage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-advanced-routes-"));
    const backend = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/instrument") return res.end(JSON.stringify({ status: "completed", content: "token=secret" }));
      return res.end(JSON.stringify({ data: { user: { identity: req.headers.authorization === "owner" ? "owner" : "other", secret: "private" } } }));
    });
    backend.listen(0, "127.0.0.1");
    await once(backend, "listening");
    servers.push(backend);
    const port = (backend.address() as import("node:net").AddressInfo).port;
    const authz = createAuthorizationRecord({ root, statement: "advanced lab", expiresInSeconds: 300, scope: { allowHosts: ["127.0.0.1"], allowPorts: [port], allowUrlPrefixes: [], denyAlways: [] } });
    saveAuthorization(authz, root);
    fs.writeFileSync(path.join(root, "app.apk"), "fixture");
    const artifact = await inspectMobileArtifact(path.join(root, "app.apk"), root);
    const engagement = new MobileEngagementStore(path.join(root, ".loam", "mobile")).create({ tenantId: "tenant-a", ownerId: "analyst-a", artifacts: [artifact] });
    const server = http.createServer((req, res) => {
      void handleAdvancedSecurityRoute(req, res, new URL(req.url ?? "/", "http://127.0.0.1"), {
        workspace: root, dataRoot: root, identity: async () => identity, readBody: body,
        sendJson: (response, status, value) => { const text = JSON.stringify(value); response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }); response.end(text); },
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    const call = async (area: string, data: unknown) => {
      const response = await fetch(`${base}/api/security/advanced/${area}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
      return { status: response.status, data: await response.json() as Record<string, unknown> };
    };
    const coverage = await call("coverage", { entries: [{ surface: "api", target: "/user", control: "bola", status: "not-tested", reason: "not run", evidenceIds: [] }] });
    assert.equal(coverage.status, 200);
    assert.equal((coverage.data.summary as { clean: boolean }).clean, false);
    const graphql = await call("graphql", { authorizationId: authz.id, url: `http://127.0.0.1:${port}/graphql`, query: "query { user { identity secret } }", privateMarker: "private", ownerIdentity: "owner", owner: { id: "owner", headers: { authorization: "owner" } }, other: { id: "other", headers: { authorization: "other" } } });
    assert.equal(graphql.status, 200);
    assert.equal((graphql.data.result as { status: string }).status, "finding");
    const key = randomBytes(32);
    process.env.LOAM_PLUGIN_SIGNING_KEY = key.toString("base64");
    const manifest = signPlugin({ version: 1, id: "advanced-pack", publisher: "Loam", kind: "scenario-pack", scopes: ["api"], scenarios: [] }, key);
    const plugin = await call("plugins", { manifest });
    assert.equal(plugin.status, 201);
    process.env.LOAM_INSTRUMENTATION_URL = `http://127.0.0.1:${port}/instrument`;
    process.env.LOAM_INSTRUMENTATION_API_KEY = "test";
    const instrumented = await call("instrumentation", { engagementId: engagement.id, deviceSerial: "emulator-5554", packageName: "com.example.app", action: "appium.capture-network" });
    assert.equal(instrumented.status, 201);
    assert.ok(!(instrumented.data.event as { content: string }).content.includes("token=secret"));
    delete process.env.LOAM_PLUGIN_SIGNING_KEY;
    delete process.env.LOAM_INSTRUMENTATION_URL;
    delete process.env.LOAM_INSTRUMENTATION_API_KEY;
  });
});
