import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";

import { ApprovalService, approvalScopeHash } from "../approvals.js";
import { SiemExporter } from "../audit.js";
import { EvidenceCipher } from "../crypto.js";
import { SharedKillSwitch } from "../killSwitch.js";
import { OidcVerifier, verifySamlGatewayIdentity } from "../oidc.js";
import { requirePermission } from "../policy.js";
import { EnterpriseQueue } from "../queue.js";
import { EnterpriseStore } from "../store.js";
import { createHmac } from "node:crypto";

const tempRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "loam-enterprise-"));
const servers: http.Server[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });

describe("approval service", () => {
  it("requires independent approvers, binds scope and prevents replay", () => {
    const service = new ApprovalService(tempRoot());
    const request = { tenantId: "tenant-a", engagementId: "ENG-1", action: "bridge:red:test", scopeHash: approvalScopeHash({ target: "https://app.test" }), requesterId: "analyst-a", destructive: true };
    assert.throws(() => service.issue(request, [{ id: "analyst-a", role: "approver" }]), /own action/);
    const token = service.issue(request, [{ id: "approver-a", role: "approver" }, { id: "approver-b", role: "admin" }]);
    assert.equal(service.verify(token, request).ok, true);
    assert.equal(service.verify(token, request).reason, "approval already used");
    assert.equal(service.verify({ ...token, action: "bridge:other" }, request, false).ok, false);
  });
});

describe("tenant policy and storage", () => {
  it("denies cross-tenant reads and permissions", () => {
    const root = tempRoot();
    const store = new EnterpriseStore(path.join(root, "state.sqlite"));
    store.put("tenant-a", "engagement", "ENG-1", { stage: "Draft" });
    assert.equal(store.get("tenant-b", "engagement", "ENG-1"), null);
    assert.equal(store.list("tenant-a", "engagement").length, 1);
    assert.throws(() => requirePermission({ id: "user-b", tenantIds: ["tenant-b"], roles: ["admin"], authMethod: "oidc" }, "tenant-a", "admin:write"), /permission denied/);
    store.close();
  });

  it("isolates queue leases and recovers expired workers", async () => {
    const queue = new EnterpriseQueue(path.join(tempRoot(), "queue.sqlite"));
    queue.enqueue("tenant-a", "mobile.scan", { engagementId: "ENG-1" }, "scan-1");
    assert.equal(queue.claim("tenant-b", "worker-b", ["mobile.scan"]), null);
    const job = queue.claim("tenant-a", "worker-a", ["mobile.scan"], 1)!;
    assert.equal(job.status, "leased");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(queue.recoverExpired(), 1);
    assert.equal(queue.get("tenant-a", job.id)?.status, "retry");
    const retried = queue.claim("tenant-a", "worker-c", ["mobile.scan"])!;
    assert.equal(queue.complete("tenant-a", retried.id, "worker-c"), true);
    queue.close();
  });
});

describe("OIDC and gateway identity", () => {
  it("verifies RS256, discovery, issuer, audience, tenant and roles", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/.well-known/openid-configuration") return res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
      if (req.url === "/jwks") return res.end(JSON.stringify({ keys: [{ ...jwk, kid: "key-1", alg: "RS256", use: "sig" }] }));
      res.statusCode = 404;
      res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const issuer = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-1", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: issuer, aud: "loam", sub: "user-a", tenant_id: "tenant-a", roles: ["analyst"], exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url");
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    const token = `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
    const identity = await new OidcVerifier({ issuer, audience: "loam" }).verify(token);
    assert.equal(identity.id, "user-a");
    assert.deepEqual(identity.tenantIds, ["tenant-a"]);
    await assert.rejects(() => new OidcVerifier({ issuer, audience: "other" }).verify(token), /audience/);
  });

  it("accepts only signed, current SAML gateway identities", () => {
    const key = randomBytes(32);
    const payload = JSON.stringify({ id: "user-a", tenantIds: ["tenant-a"], roles: ["reviewer"], expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const signature = createHmac("sha256", key).update(payload).digest("hex");
    assert.equal(verifySamlGatewayIdentity(payload, signature, key).authMethod, "saml-gateway");
    assert.throws(() => verifySamlGatewayIdentity(payload, "00", key), /signature/);
  });
});

describe("evidence encryption, SIEM and shared kill switch", () => {
  it("binds ciphertext to tenant and engagement", async () => {
    const key = randomBytes(32);
    const cipher = new EvidenceCipher({ dataKey: async () => key });
    const encrypted = await cipher.encrypt("tenant-a", "ENG-1", "EV-1", "sensitive evidence");
    assert.equal((await cipher.decrypt("tenant-a", "ENG-1", "EV-1", encrypted)).toString(), "sensitive evidence");
    await assert.rejects(() => cipher.decrypt("tenant-b", "ENG-1", "EV-1", encrypted));
  });

  it("encrypts SIEM outbox on outage and persists kill state", async () => {
    const root = tempRoot();
    const key = randomBytes(32);
    const cipher = new EvidenceCipher({ dataKey: async () => key });
    const exporter = new SiemExporter({ endpoint: "http://127.0.0.1:1/siem", signingKey: randomBytes(32), outboxFile: path.join(root, "outbox.json"), cipher, tenantId: "tenant-a", engagementId: "ENG-1" });
    const result = await exporter.export([{ seq: 1, at: new Date().toISOString(), authzId: null, capability: "test", action: "test", target: "local", params: {}, outcome: "allowed" }]);
    assert.equal(result.delivered, false);
    const outbox = fs.readFileSync(path.join(root, "outbox.json"), "utf8");
    assert.ok(!outbox.includes("sensitive") && !outbox.includes("capability"));
    const kill = new SharedKillSwitch(root);
    kill.set(true, "admin-a");
    assert.equal(new SharedKillSwitch(root).read().engaged, true);
    assert.equal(new SharedKillSwitch(root).subscription().signal.aborted, true);
    kill.set(false, "admin-a");
    assert.equal(kill.read().engaged, false);
    fs.writeFileSync(path.join(root, "kill-switch.json"), "corrupted");
    assert.equal(kill.read().engaged, true, "corrupt shared state fails closed");
  });
});
