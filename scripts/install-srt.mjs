#!/usr/bin/env node
/** Install the pinned @anthropic-ai/sandbox-runtime into the Loam data dir
 *  (OD-3, appendix C1/C8). SANDBOX_RUNTIME_INTO_LOAM §6.7.
 *
 *  Triple hash gate BEFORE anything is used: npm tarball sha256 + BOTH vendored
 *  srt-win.exe hashes (x64 + arm64) — a single mismatch aborts. Install runs with
 *  --ignore-scripts --omit=dev (LiteLLM lesson), so the node-forge/zod transitives
 *  (OD-10 CVEs) land only in the data-dir pin, never in the shipped app tree.
 *  Idempotent: a matching pin.json short-circuits. Keep the constants in sync with
 *  src/sandbox/srt/policy.ts. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.0.81";
const PKG = "@anthropic-ai/sandbox-runtime";
const TARBALL_SHA256 = "0e0b8249062047f7b592c7995f8ec2f251f3bbebdc0402db1ee23af09983953f";
const SRT_WIN = {
  // npm package layout: vendor/srt-win/<arch>/srt-win.exe (same filename per arch)
  "x64/srt-win.exe": { sha256: "a8e22bc098ac1146ec9b9151d5f1770c05b897cd1ac588161e1287a248cc9176", bytes: 4_020_736 },
  "arm64/srt-win.exe": { sha256: "c7b204c8fab94059dbf7a6a805b844abad3deb82614e07e4b8d4b5bb5c4374f7", bytes: 3_598_336 },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.MANUS_LOCAL_DATA_DIR || process.env.LOAM_DATA_DIR || path.join(root, "data");
const target = path.join(dataDir, "bin", "srt", VERSION);

// Windows: spawnSync("npm") cannot launch npm.cmd without a shell — run npm-cli.js
// from the running Node installation instead (proven pattern from install-rea-agents).
const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const npmCmd = fs.existsSync(npmCli) ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm");
const npmBase = npmCmd === process.execPath ? [process.execPath, npmCli] : [npmCmd];
const run = (args) => execFileSync(npmBase[0], [...npmBase.slice(1), ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  ...(npmBase[0].endsWith(".cmd") ? { shell: true } : {}),
});

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const die = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };

// 1. Idempotent pin.
const pinPath = path.join(target, "pin.json");
if (fs.existsSync(pinPath)) {
  const pin = JSON.parse(fs.readFileSync(pinPath, "utf8"));
  const exesOk = Object.entries(SRT_WIN).every(([name, h]) => {
    const p = path.join(target, "node_modules", PKG, "vendor", "srt-win", name);
    return fs.existsSync(p) && sha256(p) === h.sha256;
  });
  if (pin.version === VERSION && pin.tarballSha256 === TARBALL_SHA256 && exesOk) {
    console.log(`OK: srt ${VERSION} already pinned at ${target}`); process.exit(0);
  }
}

fs.mkdirSync(target, { recursive: true });
const work = fs.mkdtempSync(path.join(target, ".pack-"));

try {
  // 2. Registry integrity of the exact version must match before any fetch.
  const published = run(["view", `${PKG}@${VERSION}`, "dist.integrity"]).trim();
  if (!/^sha512-/.test(published)) die(`registry integrity missing for ${PKG}@${VERSION}`);

  // 3. npm pack the exact version, then verify the tarball sha256 against the pin.
  run(["pack", `${PKG}@${VERSION}`, "--pack-destination", work]);
  const tar = fs.readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tar) die("npm pack produced no tarball");
  const tarPath = path.join(work, tar);
  const tsha = sha256(tarPath);
  if (tsha !== TARBALL_SHA256) die(`tarball sha256 mismatch: ${tsha} (expected ${TARBALL_SHA256})`);
  console.log(`tarball sha256 verified: ${tsha.slice(0, 16)}…`);

  // 4. Install with scripts disabled into the versioned data-dir slot.
  fs.copyFileSync(tarPath, path.join(target, path.basename(tar)));
  run(["install", "--prefix", target, "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", `${PKG}@${VERSION}`]);

  // 5. Verify BOTH vendored srt-win.exe helpers (size + sha256).
  const vendorDir = path.join(target, "node_modules", PKG, "vendor", "srt-win");
  for (const [name, h] of Object.entries(SRT_WIN)) {
    const p = path.join(vendorDir, name);
    if (!fs.existsSync(p)) die(`vendored helper missing: ${name}`);
    const stat = fs.statSync(p);
    if (stat.size !== h.bytes) die(`${name} size ${stat.size} != ${h.bytes}`);
    const g = sha256(p);
    if (g !== h.sha256) die(`${name} sha256 mismatch: ${g}`);
    console.log(`${name} verified: ${g.slice(0, 16)}… (${stat.size} bytes)`);
  }

  // 6. Probe the pinned CLI (no elevation: --help exercises the entrypoint).
  const cli = path.join(target, "node_modules", PKG, "dist", "cli.js");
  if (!fs.existsSync(cli)) die(`CLI entry missing: ${cli}`);
  const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8", timeout: 30_000 });
  console.log("srt CLI probe:", (help.split(/\r?\n/).find((l) => /Usage|srt/i.test(l)) ?? "ok").trim().slice(0, 80));

  fs.writeFileSync(pinPath, JSON.stringify({
    version: VERSION, package: PKG, tarballSha256: TARBALL_SHA256,
    installedAt: new Date().toISOString(), node: process.version,
    srtWin: Object.fromEntries(Object.entries(SRT_WIN).map(([n, h]) => [n, h.sha256])),
  }, null, 2) + "\n");
  console.log(`OK: srt ${VERSION} pinned at ${target}`);
  console.log("\nOne-time OS install (user-gesture, UAC — run from Loam Settings or manually):");
  console.log(`  ${process.execPath} ${cli} windows-install --skip-profile-grant`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
