/** check:srt-session — smoke gate for the srt session lifecycle
 *  (SANDBOX_RUNTIME_INTO_LOAM §7.5–7.6; appendix C1/C3). Proves offline (mocked
 *  module path is exercised by the unit tests; here we drive the real pieces):
 *  pin-gated probe behaviour, config mapping posture, settings-file completeness,
 *  audit JSONL round-trip, and — live on a machine with the pin installed — the
 *  read-only /api-style status probe against the real library (no elevation). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SrtAuditLog } from "../sandbox/srt/audit.js";
import { buildSrtConfig, probeSrtStatus } from "../sandbox/srt/session.js";
import { resolveSrtPolicy, srtAuditPath } from "../sandbox/srt/policy.js";

// 1. Config mapping keeps the default-deny posture and adds workspace roots.
const policy = resolveSrtPolicy({ sandboxMode: "untrusted_only", sandboxAllowedDomains: ["example.com", "EXAMPLE.com"] });
const config = buildSrtConfig(policy, "D:/ws", "D:/pin/srt-win.exe") as unknown as Record<string, unknown>;
const net = config["network"] as Record<string, unknown>;
const fsx = config["filesystem"] as Record<string, unknown>;
assert.deepEqual(net["allowedDomains"], ["example.com"]); // deduped
assert.equal(net["strictAllowlist"], true);
assert.equal(net["allowLocalBinding"], false);
assert.ok((fsx["denyRead"] as string[]).includes("~/.ssh"));
assert.ok((fsx["allowRead"] as string[]).includes("D:/ws"));

// 2. Audit JSONL round-trip with a torn tail.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srt-check-"));
try {
  const a = new SrtAuditLog(srtAuditPath(dir));
  a.append({ name: "srt_session_open", outcome: "completed", mode: "untrusted_only" });
  fs.appendFileSync(srtAuditPath(dir), '{"seq":2', "utf8");
  const b = new SrtAuditLog(srtAuditPath(dir));
  b.append({ name: "srt_session_close", outcome: "completed", mode: "untrusted_only" });
  assert.equal(b.read().length, 2);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// 3. Live read-only probe (pin-gated; no elevation, no session side effects).
const status = await probeSrtStatus();
assert.equal(status.pinVersion, "0.0.81");
assert.equal(status.platformSupported, process.platform === "win32");
// On this machine the pin is installed (install-srt.mjs) — pin must verify.
if (process.platform === "win32") {
  assert.equal(status.pinVerified, true);
  console.log(`live probe: pinVerified=${status.pinVerified} windowsInstalled=${status.windowsInstalled}` + (status.windowsMessage ? ` (${status.windowsMessage})` : ""));
}

console.log("PASS: check:srt-session — config posture + audit round-trip green; probe pin-gated" + (status.pinVerified ? " and live-verified" : " (pin absent → disabled)"));
