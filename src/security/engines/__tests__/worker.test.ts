import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createAuthorizationRecord } from "../../red/gate.js";
import { evaluateEngineBenchmark } from "../benchmark.js";
import { runEngineWorker } from "../worker.js";

const root = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "loam-engine-worker-"));
const keys = ["LOAM_JADX_PATH", "LOAM_JADX_SHA256", "LOAM_AFL_PATH", "LOAM_AFL_SHA256", "LOAM_JAZZER_PATH", "LOAM_JAZZER_SHA256"];
afterEach(() => { for (const key of keys) delete process.env[key]; });

function setup(engine: "jadx" | "aflplusplus" | "jazzer") {
  const workspace = root();
  const exe = path.join(workspace, `${engine}.bin`);
  const content = Buffer.from(`pinned-${engine}`);
  fs.writeFileSync(exe, content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const prefix = engine === "jadx" ? "LOAM_JADX" : engine === "aflplusplus" ? "LOAM_AFL" : "LOAM_JAZZER";
  process.env[`${prefix}_PATH`] = exe;
  process.env[`${prefix}_SHA256`] = sha256;
  const authz = createAuthorizationRecord({ statement: "engine lab", expiresInSeconds: 300, scope: { allowHosts: ["127.0.0.1"], allowPorts: [80], allowUrlPrefixes: [], denyAlways: [] } });
  return { workspace, exe, authz };
}

describe("external engine workers", () => {
  it("runs pinned JADX only within scope", async () => {
    const { workspace, authz } = setup("jadx");
    const calls: string[][] = [];
    const result = await runEngineWorker({ engineId: "jadx", commandId: "decompile", authz, scopeTarget: "http://127.0.0.1/", target: "app.apk", workspace, licenseReviewed: true, exec: async (_exe, argv) => { calls.push(argv); return { code: 0, stdout: "decompiled", stderr: "", timedOut: false }; } });
    assert.equal(result.status, "covered");
    assert.ok(calls[0]?.some((value) => value.endsWith("app.apk")));
    assert.match(result.idempotencyKey, /^[a-f0-9]{64}$/);
  });

  it("rejects scope and hash failures before execution", async () => {
    const { workspace, authz } = setup("jadx");
    let called = false;
    const result = await runEngineWorker({ engineId: "jadx", commandId: "decompile", authz, scopeTarget: "http://example.com/", target: "app.apk", workspace, licenseReviewed: true, exec: async () => { called = true; return { code: 0, stdout: "", stderr: "", timedOut: false }; } });
    assert.equal(result.status, "unavailable");
    assert.equal(called, false);
    process.env.LOAM_JADX_SHA256 = "0".repeat(64);
    const mismatch = await runEngineWorker({ engineId: "jadx", commandId: "decompile", authz, scopeTarget: "http://127.0.0.1/", target: "app.apk", workspace, licenseReviewed: true });
    assert.equal(mismatch.status, "unavailable");
  });

  it("uses isolated AFL and Jazzer contracts with copyleft review", async () => {
    const afl = setup("aflplusplus");
    const result = await runEngineWorker({ engineId: "aflplusplus", commandId: "fuzz", authz: afl.authz, scopeTarget: "http://127.0.0.1/", target: "inputs", program: "target.bin", workspace: afl.workspace, licenseReviewed: true, exec: async () => ({ code: 0, stdout: "coverage", stderr: "", timedOut: false }) });
    assert.equal(result.status, "covered");
    const denied = await runEngineWorker({ engineId: "aflplusplus", commandId: "fuzz", authz: afl.authz, scopeTarget: "http://127.0.0.1/", target: "inputs", program: "target.bin", workspace: afl.workspace, licenseReviewed: false });
    assert.equal(denied.status, "unavailable");
    const jazzer = setup("jazzer");
    const jvm = await runEngineWorker({ engineId: "jazzer", commandId: "fuzz", authz: jazzer.authz, scopeTarget: "http://127.0.0.1/", target: "com.example.Test", program: "app.jar", workspace: jazzer.workspace, licenseReviewed: true, exec: async () => ({ code: 0, stdout: "covered", stderr: "", timedOut: false }) });
    assert.equal(jvm.status, "covered");
  });

  it("does not count unavailable or false positives as benchmark success", () => {
    const result = evaluateEngineBenchmark([
      { id: "v1", expected: "vulnerable", actual: "finding", durationMs: 10 },
      { id: "b1", expected: "benign", actual: "clean", durationMs: 10 },
      { id: "b2", expected: "benign", actual: "finding", durationMs: 10 },
      { id: "v2", expected: "vulnerable", actual: "unavailable", durationMs: 10 },
    ]);
    assert.equal(result.fp, 1);
    assert.equal(result.fn, 1);
    assert.equal(result.passed, false);
  });
});
