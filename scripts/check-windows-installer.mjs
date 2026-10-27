import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
const installer = path.resolve(process.argv[2] || process.env.LOAM_INSTALLER || `release/Loam-Setup-${pkg.version}.exe`);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "loam-installer-check-"));
const installDir = path.join(root, "app");
const profile = path.join(root, "profile");
const executable = path.join(installDir, "Loam.exe");
const uninstaller = path.join(installDir, "Uninstall Loam.exe");
const marker = path.join(profile, "preservation-marker.json");
const report = { installer, installDir, profile, installed: false, uninstalled: false, dataPreserved: false, reinstalled: false, updaterChecks: false };
let installed = false;

async function run(command, args, options = {}) {
  const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options });
  let output = "";
  child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-6000); });
  child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-6000); });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`${command} exited ${code}\n${output}`);
}

async function waitForFile(file, present = true) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const exists = await fs.access(file).then(() => true, () => false);
    if (exists === present) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${file} to be ${present ? "present" : "removed"}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function install() {
  await run(installer, ["/S", `/D=${installDir}`]);
  await waitForFile(executable);
  await waitForFile(uninstaller);
  installed = true;
}

async function uninstall() {
  await run(uninstaller, ["/S", `_?=${installDir}`]);
  await waitForFile(executable, false);
  installed = false;
}

async function smoke() {
  await run(process.execPath, ["src/scripts/check-packaged-loam.mjs", executable], {
    env: { ...process.env, LOAM_PACKAGED_PROFILE: profile },
    cwd: process.cwd(),
  });
}

try {
  assert.equal(process.platform, "win32", "NSIS acceptance requires Windows");
  await fs.access(installer);
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(marker, JSON.stringify({ preserved: true }));
  await install();
  report.installed = true;
  await smoke();
  await run(process.execPath, ["scripts/check-app-updater.mjs"]);
  report.updaterChecks = true;
  await uninstall();
  report.uninstalled = true;
  assert.equal(JSON.parse(await fs.readFile(marker, "utf8")).preserved, true);
  report.dataPreserved = true;
  await install();
  assert.equal(JSON.parse(await fs.readFile(marker, "utf8")).preserved, true);
  await smoke();
  report.reinstalled = true;
  console.log(`PASS NSIS install, packaged smoke, updater, uninstall, data preservation and reinstall: ${root}`);
} finally {
  if (installed) await uninstall().catch(() => {});
  const out = path.resolve("output/verification/windows-installer");
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, "result.json"), JSON.stringify(report, null, 2));
  await fs.rm(root, { recursive: true, force: true });
}
