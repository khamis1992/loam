#!/usr/bin/env node
/** Install the pinned Cua Driver into the Loam data dir (OD-3, OD-7c, §6.7).
 *  CUA_INTO_LOAM_INTEGRATION appendix B8/B9.
 *
 *  Order: (1) detect an existing official install (PATH / ~/.cua-driver/packages/current)
 *  and report it; (2) otherwise download the pinned GitHub release asset, verify
 *  sha256 TWICE (recorded constant + the release's own SHA256SUMS), extract into
 *  <DATA_DIR>/bin/cua-driver/<version>/, drop the Mark-of-the-Web (Unblock-File)
 *  and run a warn-only Authenticode check, then write pin.json. Never runs
 *  install.ps1 / irm|iex. Keep constants in sync with src/tools/cuaDriverAllowlist.ts. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.38.0";
const ASSET = "cua-driver-rs-0.38.0-windows-x86_64.zip";
const ASSET_URL = "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/cua-driver-rs-0.38.0-windows-x86_64.zip";
const SHA256SUMS_URL = "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/SHA256SUMS";
const SHA256 = "997f20114ad3db227a854e1e5a886234f76405b155f4af70605d4b7ca4a436a1";
const ASSET_BYTES = 35_894_668;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.MANUS_LOCAL_DATA_DIR || process.env.LOAM_DATA_DIR || path.join(root, "data");
const target = path.join(dataDir, "bin", "cua-driver", VERSION);

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const die = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };

// 1. Existing official install wins (OD-7c: detect, then offer pin).
const candidates = [];
try { candidates.push(execFileSync("where", ["cua-driver"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]); } catch { /* not on PATH */ }
const current = path.join(process.env.USERPROFILE || "", ".cua-driver", "packages", "current", "cua-driver.exe");
if (fs.existsSync(current)) candidates.push(current);
const existing = candidates.find((p) => p && fs.existsSync(p));
if (existing) {
  console.log(`OK: existing cua-driver detected at ${existing}`);
  console.log(`     (Loam still prefers its own pin; point config.json there or keep the ${VERSION} pin below)`);
}

// 2. Idempotent pin.
const pinPath = path.join(target, "pin.json");
if (fs.existsSync(pinPath)) {
  const pin = JSON.parse(fs.readFileSync(pinPath, "utf8"));
  if (pin.version === VERSION && pin.assetSha256 === SHA256 && fs.existsSync(path.join(target, "cua-driver.exe"))) {
    console.log(`OK: cua-driver ${VERSION} already pinned at ${target}`);
    process.exit(0);
  }
}

fs.mkdirSync(target, { recursive: true });
const zipPath = path.join(target, ASSET);

// 3. Download (Node fetch, no shell piping).
if (!fs.existsSync(zipPath) || sha256(zipPath) !== SHA256) {
  console.log(`downloading ${ASSET} (${(ASSET_BYTES / 1e6).toFixed(1)} MB)...`);
  const res = await fetch(ASSET_URL, { redirect: "follow" });
  if (!res.ok) die(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== ASSET_BYTES) die(`size mismatch: got ${buf.length}, expected ${ASSET_BYTES}`);
  fs.writeFileSync(zipPath, buf);
}

// 4. Verify sha256 twice: recorded constant, then the release's own SHA256SUMS.
const local = sha256(zipPath);
if (local !== SHA256) die(`sha256 mismatch vs recorded pin: ${local}`);
const sumsRes = await fetch(SHA256SUMS_URL, { redirect: "follow" });
if (!sumsRes.ok) die(`cannot fetch SHA256SUMS: HTTP ${sumsRes.status}`);
const sums = await sumsRes.text();
const listed = (sums.split(/\r?\n/).find((l) => l.includes(ASSET)) ?? "").trim().split(/\s+/)[0];
if (!listed) die(`SHA256SUMS does not list ${ASSET}`);
if (listed.toLowerCase() !== SHA256) die(`SHA256SUMS disagrees: ${listed}`);

// 5. Extract (PowerShell Expand-Archive), then flatten: the zip nests everything
//    under cua-driver-rs-<version>-<target>/ — the pin slot must hold the files directly.
const extractDir = path.join(target, "pkg");
fs.rmSync(extractDir, { recursive: true, force: true });
fs.mkdirSync(extractDir, { recursive: true });
execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`], { stdio: "inherit" });
let pkgRoot = extractDir;
const top = fs.readdirSync(extractDir, { withFileTypes: true });
if (top.length === 1 && top[0].isDirectory()) pkgRoot = path.join(extractDir, top[0].name);
if (!fs.existsSync(path.join(pkgRoot, "cua-driver.exe"))) die(`cua-driver.exe not found in ${ASSET}`);
for (const name of fs.readdirSync(pkgRoot)) {
  const to = path.join(target, name);
  if (name !== "pin.json" && name !== ASSET) { try { fs.rmSync(to, { recursive: true, force: true }); fs.renameSync(path.join(pkgRoot, name), to); } catch { /* best effort */ } }
}
fs.rmSync(extractDir, { recursive: true, force: true });

// 6. Post-verification: MOTW removal + warn-only Authenticode + a stdio handshake probe.
execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  `Get-ChildItem -LiteralPath '${target}' -Recurse -File | Unblock-File`], { stdio: "ignore" });
try {
  const sig = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-AuthenticodeSignature -LiteralPath '${path.join(target, "cua-driver.exe")}').Status`], { encoding: "utf8" }).trim();
  console.log(sig === "Valid" ? "Authenticode: Valid" : `Authenticode: ${sig} (warn-only; sha256 already verified)`);
} catch { console.log("Authenticode: check unavailable (warn-only; sha256 already verified)"); }

const versionOut = execFileSync(path.join(target, "cua-driver.exe"), ["--version"], { encoding: "utf8", timeout: 30_000 }).trim();
console.log(`driver reports: ${versionOut.split(/\r?\n/)[0]}`);

fs.writeFileSync(pinPath, JSON.stringify({
  version: VERSION, asset: ASSET, assetSha256: SHA256, installedAt: new Date().toISOString(),
  source: ASSET_URL, exeSha256: sha256(path.join(target, "cua-driver.exe")),
}, null, 2) + "\n");

console.log(`OK: cua-driver ${VERSION} pinned at ${target}`);
console.log("\nmcpServers config (add to config.json to enable the desktop-driver path):");
console.log(JSON.stringify({
  "cua-driver": {
    command: `${target.replace(/\\/g, "/")}/cua-driver.exe`,
    args: ["mcp"],
    env: { CUA_DRIVER_PERMISSION_MODE: "standard" },
    allowlist: true,
  },
}, null, 2));
