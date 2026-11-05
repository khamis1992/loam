#!/usr/bin/env node
/*
 * Install a prebuilt Loam Recorder dist. This never runs on npm install.
 * The published zip sha256 lives in scripts/vendor/recorder/manifest.json.
 * Until that sha is filled, the script refuses to download anything.
 * Licence files inside the zip are kept (they are not pruned).
 *
 *   node scripts/vendor/fetch-recorder.mjs
 *   LOAM_RECORDER_ZIP=./loam-recorder.zip node scripts/vendor/fetch-recorder.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractZip } from "./lib/zip.mjs";
import { findDirContaining, installArchive, sha256Hex, verifySha256, writeVendorJson } from "./lib/vendor.mjs";
import { rebrandTree } from "../../electron/recorder/rebrand.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST_PATH = path.join(ROOT, "scripts", "vendor", "recorder", "manifest.json");
const DIST = path.join(ROOT, "electron", "recorder", "dist");

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

export async function fetchRecorder(options = {}) {
  const manifest = options.manifest ?? readManifest();
  const zipPath = options.zipPath || process.env.LOAM_RECORDER_ZIP || "";
  if (!zipPath) {
    if (!manifest.sha256) {
      throw new Error("Loam Recorder has no published zip yet. Build it with npm run vendor:recorder:build, then set manifest.sha256.");
    }
    throw new Error("Set LOAM_RECORDER_ZIP to the sha256-pinned archive from the vendor build.");
  }
  const file = path.resolve(zipPath);
  if (!fs.existsSync(file)) throw new Error(`LOAM_RECORDER_ZIP not found: ${file}`);
  const buf = fs.readFileSync(file);
  if (manifest.sha256) verifySha256(sha256Hex(buf), manifest.sha256);
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  const files = installArchive(buf, DIST);
  const binTmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-recorder-bin-"));
  try {
    extractZip(buf, binTmp);
    const helperDir = findDirContaining(binTmp, "wgc-capture.exe");
    if (helperDir) {
      const dest = path.join(ROOT, "resources", "recorder", "bin", "win32-x64");
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(helperDir, dest, { recursive: true });
    }
  } finally {
    fs.rmSync(binTmp, { recursive: true, force: true });
  }
  const branded = rebrandTree(DIST);
  if (branded.leftover.length > 0) {
    throw new Error(`rebrand left openscreen in ${branded.leftover.join(", ")}`);
  }
  writeVendorJson(DIST, {
    app: "recordercraft",
    rev: manifest.rev,
    source: `file:${file}`,
    sha256: sha256Hex(buf),
  });
  return { distDir: DIST, files, rebranded: branded.changed.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fetchRecorder().then(
    (result) => console.log(`recorder: installed ${result.files.length} file(s) at ${result.distDir}`),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
