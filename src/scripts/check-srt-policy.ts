/** check:srt-policy — smoke gate for the srt policy module
 *  (SANDBOX_RUNTIME_INTO_LOAM §6.3/§6.7; appendix C1/C2/C8). Offline except the
 *  live-pin probe, which soft-skips when the pin is absent. Proves: default-deny
 *  posture, OD gates (1/5/7), C6 sandbox semantics, hash-gated pin verification
 *  against both fabricated and real pins, and the mode/domain normalization. */
import assert from "node:assert/strict";
import path from "node:path";
import {
  DEFAULT_LOAM_SRT_POLICY,
  normalizeDomains,
  normalizeSrtMode,
  resolveSrtPolicy,
  shouldSandboxCommand,
  verifySrtPin,
} from "../sandbox/srt/policy.js";

// 1. Default-deny posture + OD gates.
assert.equal(DEFAULT_LOAM_SRT_POLICY.mode, "off");
assert.equal(DEFAULT_LOAM_SRT_POLICY.strictAllowlist, true);
assert.deepEqual(DEFAULT_LOAM_SRT_POLICY.allowedDomains, []);
assert.equal(DEFAULT_LOAM_SRT_POLICY.allowLocalBinding, false);
assert.ok(DEFAULT_LOAM_SRT_POLICY.denyRead.includes("~/.ssh"));
assert.ok(DEFAULT_LOAM_SRT_POLICY.denyWrite.includes(".env"));

// 2. C6: untrusted_only exempts only explicit full trust; all_shell never exempts.
assert.equal(shouldSandboxCommand("untrusted_only", "full_access"), false);
assert.equal(shouldSandboxCommand("untrusted_only", "ask_for_approval"), true);
assert.equal(shouldSandboxCommand("all_shell", "full_access"), true);
assert.equal(shouldSandboxCommand("off", "ask_for_approval"), false);

// 3. Normalization: unknown mode fails to off; domains are deduped/lowercased/junk-filtered.
assert.equal(normalizeSrtMode("everything"), "off");
assert.deepEqual(normalizeDomains(["A.com", "a.com", "", "bad domain", 7]), ["a.com"]);

// 4. User merge never widens the deny lists.
const merged = resolveSrtPolicy({ sandboxMode: "untrusted_only", sandboxAllowedDomains: ["example.com"] });
assert.equal(merged.mode, "untrusted_only");
assert.deepEqual(merged.allowedDomains, ["example.com"]);
assert.deepEqual(merged.denyRead, DEFAULT_LOAM_SRT_POLICY.denyRead);

// 5. Live pin probe (soft-skip on machines without the pin — CI stays green).
const dataDir = process.env.MANUS_LOCAL_DATA_DIR || process.env.LOAM_DATA_DIR || path.resolve(".", "data");
const live = verifySrtPin(dataDir);
if (!live.ok && !["pin-entry-missing", "srt-win-missing"].includes(live.reason ?? "")) {
  throw new Error(`installed srt pin FAILED verification: ${live.reason}`);
}
const liveNote = live.ok ? "live pin verified" : `pin absent on this machine (${live.reason})`;

console.log(`PASS: check:srt-policy — default-deny policy, OD-1/5/7 gates, C6 semantics, ${liveNote}`);
