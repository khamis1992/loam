#!/usr/bin/env node
/*
 * fetch-api-anything.mjs — reproducible vendoring of api-anything at a pinned commit.
 *
 * Usage: npm run vendor:api-anything [-- --force]
 *
 * Steps (each one aborts the run on failure):
 *   1. Read addons/api-anything/UPSTREAM.json (repository, commit, packageLockSha256).
 *   2. If addons/api-anything/pkg/.vendored equals the commit and --force is absent, stop.
 *   3. git clone --filter=blob:none --no-checkout <repo> <tmp>; git checkout --detach <commit>;
 *      git rev-parse HEAD must equal the commit.
 *   4. sha256(package-lock.json) must equal packageLockSha256.
 *   5. npm ci --ignore-scripts (no lifecycle scripts, so upstream's "prepare" never runs).
 *   6. node node_modules/typescript/bin/tsc -p tsconfig.build.json (upstream's own build).
 *   7. npm prune --omit=dev --ignore-scripts.
 *   8. Copy only UPSTREAM.json "keep" entries to addons/api-anything/pkg.
 *  8b. Write pkg/LICENSES.txt (name@version: licence of every vendored dependency).
 *   9. Smoke: node pkg/dist/cli.js --version must print UPSTREAM.json "version".
 *
 * Must be run through npm (npm run …) so npm_execpath points at npm's JS entry: on Windows
 * spawning npm.cmd without a shell is refused by Node, and this script never uses a shell.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADDON = path.join(ROOT, "addons", "api-anything");
const PKG = path.join(ADDON, "pkg");
const MARKER = path.join(PKG, ".vendored");
const upstream = JSON.parse(fs.readFileSync(path.join(ADDON, "UPSTREAM.json"), "utf8"));
const force = process.argv.includes("--force");

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  throw new Error(`Node ${process.versions.node} is below api-anything's engine ${upstream.nodeEngine}`);
}
if (!/^[0-9a-f]{40}$/.test(upstream.commit)) throw new Error("UPSTREAM.json commit must be a full 40-char SHA");
if (!/^[0-9a-f]{64}$/.test(upstream.packageLockSha256)) throw new Error("UPSTREAM.json packageLockSha256 must be 64 hex chars");
const NPM_CLI = process.env.npm_execpath;
if (!NPM_CLI || !fs.existsSync(NPM_CLI)) throw new Error("run this through npm: npm run vendor:api-anything");

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: false, windowsHide: true });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.join(" ")} failed: ${r.error?.message ?? `exit ${r.status}`}`);
}
function capture(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", shell: false, windowsHide: true });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.join(" ")} failed: ${r.stderr || r.error?.message}`);
  return r.stdout.trim();
}
const npm = (args, cwd) => run(process.execPath, [NPM_CLI, ...args], cwd);
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

if (!force && fs.existsSync(MARKER) && fs.readFileSync(MARKER, "utf8").trim() === upstream.commit) {
  console.log(`api-anything ${upstream.commit.slice(0, 7)} already vendored (use --force to rebuild)`);
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-api-anything-"));
try {
  const src = path.join(tmp, "src");
  run("git", ["clone", "--filter=blob:none", "--no-checkout", upstream.repository, src], tmp);
  run("git", ["-c", "advice.detachedHead=false", "checkout", "--detach", upstream.commit], src);
  const head = capture("git", ["rev-parse", "HEAD"], src);
  if (head !== upstream.commit) throw new Error(`checked out ${head}, expected ${upstream.commit}`);
  const lockHash = sha256(path.join(src, "package-lock.json"));
  if (lockHash !== upstream.packageLockSha256) throw new Error(`package-lock.json sha256 ${lockHash} does not match the pin`);
  const pkgJson = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8"));
  if (pkgJson.version !== upstream.version) throw new Error(`package.json version ${pkgJson.version}, expected ${upstream.version}`);

  npm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], src);
  run(process.execPath, [path.join(src, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"], src);
  if (!fs.existsSync(path.join(src, "dist", "cli.js"))) throw new Error("build produced no dist/cli.js");
  npm(["prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], src);

  fs.rmSync(PKG, { recursive: true, force: true });
  fs.mkdirSync(PKG, { recursive: true });
  for (const entry of upstream.keep) {
    const from = path.join(src, entry);
    if (!fs.existsSync(from)) throw new Error(`missing ${entry} in the build`);
    fs.cpSync(from, path.join(PKG, entry), { recursive: true });
  }
  // 8b. Licence list of every vendored npm dependency (THIRD_PARTY_NOTICES points here).
  const licenses = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name.startsWith("@")) {
        walk(full);
        continue;
      }
      const pj = path.join(full, "package.json");
      if (!fs.existsSync(pj)) continue;
      const meta = JSON.parse(fs.readFileSync(pj, "utf8"));
      licenses.push(`${meta.name}@${meta.version}: ${typeof meta.license === "string" ? meta.license : JSON.stringify(meta.license ?? "UNKNOWN")}`);
      const nested = path.join(full, "node_modules");
      if (fs.existsSync(nested)) walk(nested);
    }
  };
  walk(path.join(PKG, "node_modules"));
  fs.writeFileSync(path.join(PKG, "LICENSES.txt"), `${licenses.sort().join("\n")}\n`);

  const version = capture(process.execPath, [path.join(PKG, "dist", "cli.js"), "--version"], PKG);
  if (version !== upstream.version) throw new Error(`vendored cli prints ${version}, expected ${upstream.version}`);
  fs.writeFileSync(MARKER, `${upstream.commit}\n`);
  console.log(`api-anything ${upstream.version} @ ${upstream.commit.slice(0, 7)} vendored into addons/api-anything/pkg`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
