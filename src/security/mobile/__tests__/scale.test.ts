import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";

import { EvidenceCipher } from "../../enterprise/crypto.js";
import { createAuthorizationRecord } from "../../red/gate.js";
import { redTransport } from "../../red/transport.js";
import { testMobileAuthorization } from "../apiAuthorization.js";
import { buildAttackPaths } from "../attackPath.js";
import { runBusinessScenario } from "../businessLogic.js";
import { EvidenceTimeline } from "../evidenceTimeline.js";
import { MobileDeviceFarm, type FarmDevice } from "../farm.js";
import { replayMobileRequest } from "../replay.js";
import { MOBILE_SCENARIOS, validateScenarioCatalog } from "../scenarios.js";
import { AndroidDeviceWorker } from "../worker.js";
import { inspectMobileArtifact } from "../artifacts.js";

const tempRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "loam-mobile-scale-"));
const servers: http.Server[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });

describe("expanded scenarios and evidence", () => {
  it("validates at least 20 linked scenarios and encrypts timeline evidence", async () => {
    validateScenarioCatalog();
    assert.ok(MOBILE_SCENARIOS.length >= 20);
    const root = tempRoot();
    const key = randomBytes(32);
    const timeline = new EvidenceTimeline(root, new EvidenceCipher({ dataKey: async () => key }));
    await timeline.append("tenant-a", "ENG-1", { kind: "request", summary: "Authorized request", content: "token=secret", relatedFindingIds: ["F1"] });
    const raw = fs.readFileSync(path.join(root, "tenant-a", "ENG-1.jsonl"), "utf8");
    assert.ok(!raw.includes("token=secret"));
    const events = await timeline.list("tenant-a", "ENG-1");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.relatedFindingIds[0], "F1");
  });

  it("builds only evidence-backed attack paths", () => {
    const paths = buildAttackPaths(
      [{ id: "app", kind: "application", label: "App" }, { id: "api", kind: "api", label: "API" }, { id: "data", kind: "data", label: "Records", sensitive: true }],
      [{ from: "app", to: "api", action: "request", evidenceIds: ["EV1"] }, { from: "api", to: "data", action: "read", evidenceIds: ["EV2"] }],
    );
    assert.equal(paths.length, 1);
    assert.deepEqual(paths[0]?.evidenceIds, ["EV1", "EV2"]);
    assert.throws(() => buildAttackPaths([{ id: "app", kind: "application", label: "App" }], [{ from: "app", to: "missing", action: "x", evidenceIds: [] }]));
  });
});

describe("device farm", () => {
  it("isolates leases and requires cleanup proof before reuse", () => {
    const farm = new MobileDeviceFarm(path.join(tempRoot(), "farm.sqlite"));
    const device: FarmDevice = { id: "android-1", platform: "android", osVersion: "15", capabilities: ["adb", "logcat"], workerVersion: "1.0.0", imageDigest: `sha256:${"a".repeat(64)}`, health: "healthy" };
    farm.register(device);
    assert.equal(farm.lease("tenant-a", "ENG-1", { platform: "android" })?.id, device.id);
    assert.equal(farm.lease("tenant-b", "ENG-2", { platform: "android" }), null);
    assert.throws(() => farm.release("tenant-b", "ENG-2", device.id, { success: true, evidenceSha256: "b".repeat(64) }), /lease mismatch/);
    farm.release("tenant-a", "ENG-1", device.id, { success: false, evidenceSha256: "b".repeat(64) });
    assert.equal(farm.lease("tenant-c", "ENG-3", { platform: "android" }), null);
    farm.register(device);
    farm.lease("tenant-a", "ENG-1", { platform: "android" });
    farm.release("tenant-a", "ENG-1", device.id, { success: true, evidenceSha256: "b".repeat(64) });
    assert.equal(farm.lease("tenant-c", "ENG-3", { platform: "android" })?.id, device.id);
    farm.close();
  });

  it("requires separate approval for data wipe", async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, "app.apk"), "fixture");
    const artifact = await inspectMobileArtifact(path.join(root, "app.apk"), root);
    const calls: string[][] = [];
    const worker = new AndroidDeviceWorker({ serial: "emulator-5554", packageName: "com.example.app", approved: true, allowDataWipe: true, exec: async (args) => { calls.push(args); return { code: 0, stdout: "Success", stderr: "", timedOut: false }; } });
    const result = await worker.cleanup();
    assert.equal(result.success, true);
    assert.ok(calls.some((args) => args.includes("clear")));
    await assert.rejects(() => new AndroidDeviceWorker({ serial: "emulator-5554", packageName: "com.example.app", approved: true }).cleanup(), /separate explicit approval/);
    void artifact;
  });
});

describe("authorized dynamic testing", () => {
  it("detects BOLA with a positive control and rejects missing markers", async () => {
    const server = http.createServer((req, res) => {
      const auth = req.headers.authorization;
      if (req.url === "/vulnerable") {
        if (auth === "owner" || auth === "other") return res.end(JSON.stringify({ identity: "owner", marker: "private-record" }));
        return res.end("denied");
      }
      if (req.url === "/safe") {
        if (auth === "owner") return res.end(JSON.stringify({ identity: "owner", marker: "private-record" }));
        res.statusCode = 403;
        return res.end("denied");
      }
      if (auth === "owner") return res.end(JSON.stringify({ identity: "owner", marker: "private-record" }));
      res.end(JSON.stringify({ identity: "public" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const port = (server.address() as import("node:net").AddressInfo).port;
    const authz = createAuthorizationRecord({ statement: "local dynamic lab", expiresInSeconds: 300, scope: { allowHosts: ["127.0.0.1"], allowPorts: [port], allowUrlPrefixes: [], denyAlways: [] } });
    const owner = { id: "owner", headers: { authorization: "owner" } };
    const other = { id: "other", headers: { authorization: "other" } };
    assert.equal((await testMobileAuthorization(authz, { id: "bola", url: `http://127.0.0.1:${port}/vulnerable`, privateMarker: "private-record", ownerIdentity: "owner" }, owner, other)).status, "finding");
    assert.equal((await testMobileAuthorization(authz, { id: "safe", url: `http://127.0.0.1:${port}/safe`, privateMarker: "private-record", ownerIdentity: "owner" }, owner, other)).status, "pass");
    assert.equal((await testMobileAuthorization(authz, { id: "ambiguous", url: `http://127.0.0.1:${port}/ambiguous`, privateMarker: "private-record", ownerIdentity: "owner" }, owner, other)).status, "inconclusive");
    const replay = await replayMobileRequest(authz, redTransport(authz, { authHeaders: owner.headers, authOrigin: `http://127.0.0.1:${port}` }), { url: `http://127.0.0.1:${port}/safe`, expectedStatus: 200, expectedMarker: "private-record" });
    assert.equal(replay.status, "pass");
  });

  it("evaluates order, quota, replay and offline state with witnesses", async () => {
    const execute = async (step: string): Promise<{ accepted: boolean; state?: string; evidenceId: string }> => ({ accepted: true, state: step, evidenceId: `EV-${step}` });
    const order = await runBusinessScenario({ id: "order", kind: "step-order", steps: ["pay", "login"], expectedOrder: ["login", "pay"] }, execute);
    assert.equal(order.status, "finding");
    const quota = await runBusinessScenario({ id: "quota", kind: "quota", steps: ["a", "b", "c"], quota: 2 }, execute);
    assert.equal(quota.status, "finding");
    let count = 0;
    const replay = await runBusinessScenario({ id: "replay", kind: "replay", steps: ["charge", "charge"] }, async (step) => ({ accepted: true, state: `count-${++count}`, evidenceId: step }));
    assert.equal(replay.status, "finding");
    const offline = await runBusinessScenario({ id: "offline", kind: "offline", steps: ["sync"], expectedFinalState: "server-confirmed" }, async () => ({ accepted: true, state: "local-only", evidenceId: "EV1" }));
    assert.equal(offline.status, "finding");
  });
});
