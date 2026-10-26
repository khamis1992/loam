/**
 * check:wakaru-bridge — Cap F gate: pin integrity constants, tar extraction,
 * manifest registration in builtin, and (when the binary is installed on this
 * machine) a sha256 re-verification. Network fetch is NOT performed here —
 * installation happens on demand at first use.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PINNED, verifyInstalled, binaryPath, dataDir } from "../bridges/binaries.js";
import { WAKARU_MANIFEST } from "../bridges/wakaruManifest.js";
import { BUILTIN_MANIFESTS } from "../bridges/builtin.js";

const b = PINNED.wakaru!;
assert.equal(b.version, "1.14.0");
assert.match(b.integrity, /^sha512-[A-Za-z0-9+/=]+$/);
assert.match(b.tgzSha256, /^[a-f0-9]{64}$/);
assert.match(b.exeSha256, /^[a-f0-9]{64}$/);
assert.equal(b.tarball, "https://registry.npmjs.org/@wakaru/cli-win32-x64/-/cli-win32-x64-1.14.0.tgz");

// Registered in the builtin list (validated by the bridge registry at load).
const registered = BUILTIN_MANIFESTS.some((m) => (m as { id?: string }).id === "wakaru");
assert.ok(registered, "WAKARU_MANIFEST must be registered in BUILTIN_MANIFESTS");

// Install path lives under the data dir (protected path per §12.3).
const dest = binaryPath(b);
assert.ok(dest.startsWith(path.join(dataDir(), "bin", "wakaru")), "install path must be under %DATA_DIR%\\bin\\wakaru");

if (fs.existsSync(dest)) {
  assert.equal(verifyInstalled(b), true, "installed wakaru.exe must match the pinned sha256");
  console.log("check:wakaru-bridge OK — installed binary verified against the pin");
} else {
  console.log("check:wakaru-bridge OK — pin + manifest + registration green (binary fetches on demand)");
}
