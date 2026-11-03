#!/usr/bin/env node
/** Install the pinned external REA MCP server into the Loam data dir (OD-2, OD-5).
 *  REA_INTO_LOAM_INTEGRATION §4.7 — exact version, registry SRI verified BEFORE
 *  install, --ignore-scripts (LiteLLM 1.107.0 lesson: never run lifecycle scripts
 *  of unreviewed packages). Idempotent: a matching pin.json short-circuits.
 *
 *  Keep REA_VERSION_PIN / REA_NPM_INTEGRITY in sync with src/tools/reaAllowlist.ts
 *  (check:rea-allowlist asserts the shape of the TypeScript copy). */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "6.7.0";
const INTEGRITY = "sha512-yhIx2ioJYYT1C/tONfYeitC6LhnKmCh+ZwRUOgYuhSc733lGhkkt73zhug9WmLgxoMdKuqIYGCoBfD4fXkOhFw==";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.MANUS_LOCAL_DATA_DIR || process.env.LOAM_DATA_DIR || path.join(root, "data");
const target = path.join(dataDir, "bin", "rea-agents", VERSION);

// Windows: spawnSync("npm") cannot launch npm.cmd without a shell. Run npm-cli.js
// from the running Node installation instead — no shell, no quoting hazards.
const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const npmCmd = fs.existsSync(npmCli) ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm");
const npmBase = npmCmd === process.execPath ? [process.execPath, npmCli] : [npmCmd];
const run = (args) => execFileSync(npmBase[0], [...npmBase.slice(1), ...args], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
  ...(npmBase[0].endsWith(".cmd") ? { shell: true } : {}),
});

// 1. Registry integrity must match the recorded pin before anything is fetched.
const published = run(["view", `rea-agents@${VERSION}`, "dist.integrity"]).trim();
if (published !== INTEGRITY) {
  console.error(`FAIL: registry integrity for rea-agents@${VERSION} changed.\n  expected ${INTEGRITY}\n  registry ${published}\nRe-review the release, then update the pin in BOTH scripts/install-rea-agents.mjs and src/tools/reaAllowlist.ts.`);
  process.exit(1);
}

// 2. Idempotent: an existing install with a matching pin is left untouched.
const pinPath = path.join(target, "pin.json");
if (fs.existsSync(pinPath)) {
  const pin = JSON.parse(fs.readFileSync(pinPath, "utf8"));
  if (pin.version === VERSION && pin.integrity === INTEGRITY) {
    console.log(`OK: rea-agents@${VERSION} already installed at ${target}`);
    process.exit(0);
  }
}

// 3. Install with scripts disabled into the versioned data-dir slot.
fs.mkdirSync(target, { recursive: true });
run(["install", "--prefix", target, "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", `rea-agents@${VERSION}`]);

// 4. Verify what landed: exact version, entry script present, no lifecycle damage.
const pkgPath = path.join(target, "node_modules", "rea-agents", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
if (pkg.version !== VERSION) throw new Error(`installed version ${pkg.version} != pin ${VERSION}`);
const entry = path.join(target, "node_modules", "rea-agents", "scripts", "rea.mjs");
if (!fs.existsSync(entry)) throw new Error(`entry script missing: ${entry}`);

const pin = {
  version: VERSION,
  integrity: INTEGRITY,
  installedAt: new Date().toISOString(),
  node: process.version,
  entrySha256: createHash("sha256").update(fs.readFileSync(entry)).digest("hex"),
};
fs.writeFileSync(pinPath, JSON.stringify(pin, null, 2) + "\n");

console.log(`OK: rea-agents@${VERSION} installed at ${target}`);
console.log("\nmcpServers config (add to config.json when enabling the reverse-engineer mode):");
console.log(JSON.stringify({
  rea: {
    command: "node",
    args: [entry.replace(/\\/g, "/"), "mcp"],
    env: { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
  },
}, null, 2));
