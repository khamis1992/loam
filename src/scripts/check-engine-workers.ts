import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { evaluateEngineBenchmark } from "../security/engines/benchmark.js";
import { runEngineWorker } from "../security/engines/worker.js";
import { createAuthorizationRecord } from "../security/red/gate.js";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-engine-acceptance-"));
const exe = path.join(workspace, "jadx.bin");
const content = Buffer.from("pinned-jadx-acceptance");
fs.writeFileSync(exe, content);
process.env.LOAM_JADX_PATH = exe;
process.env.LOAM_JADX_SHA256 = createHash("sha256").update(content).digest("hex");
const authz = createAuthorizationRecord({ statement: "engine acceptance lab", expiresInSeconds: 300, scope: { allowHosts: ["127.0.0.1"], allowPorts: [80], allowUrlPrefixes: [], denyAlways: [] } });

try {
  const vulnerable = await runEngineWorker({ engineId: "jadx", commandId: "decompile", authz, scopeTarget: "http://127.0.0.1/", target: "vulnerable.apk", workspace, licenseReviewed: true, exec: async () => ({ code: 0, stdout: "sensitive endpoint exposed", stderr: "", timedOut: false }) });
  const benign = await runEngineWorker({ engineId: "jadx", commandId: "decompile", authz, scopeTarget: "http://127.0.0.1/", target: "safe.apk", workspace, licenseReviewed: true, exec: async () => ({ code: 0, stdout: "no security-relevant observation", stderr: "", timedOut: false }) });
  const unavailable = await runEngineWorker({ engineId: "jadx", commandId: "decompile", authz, scopeTarget: "http://example.com/", target: "vulnerable.apk", workspace, licenseReviewed: true });
  const result = evaluateEngineBenchmark([
    { id: "vulnerable", expected: "vulnerable", actual: vulnerable.status === "covered" ? "finding" : "inconclusive", durationMs: 1 },
    { id: "benign", expected: "benign", actual: benign.status === "covered" ? "clean" : "inconclusive", durationMs: 1 },
    { id: "out-of-scope", expected: "vulnerable", actual: unavailable.status === "unavailable" ? "unavailable" : "finding", durationMs: 1 },
  ]);
  assert.equal(result.tp, 1);
  assert.equal(result.tn, 1);
  assert.equal(result.fp, 0);
  assert.equal(result.fn, 1, "out-of-scope must not be hidden; it is excluded from clean only as unavailable");
  assert.equal(result.unavailable, 1);
  assert.equal(result.passed, false, "benchmark cannot pass with unavailable cases");
  console.log("check:engine-workers PASS — pinned worker, safe twin, hash/scope denial, and unavailable accounting are correct");
} finally {
  delete process.env.LOAM_JADX_PATH;
  delete process.env.LOAM_JADX_SHA256;
}
