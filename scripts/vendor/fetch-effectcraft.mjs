#!/usr/bin/env node
/*
 * fetch-effectcraft.mjs — reproducible vendoring of the "Loam Effects" backend
 * dist (transitions, effects and text/motion animation for Loam Video).
 *
 * EffectCraft has no GitHub release, so sources are tried in order:
 *   1. LOAM_EFFECTCRAFT_ZIP  — a local zip of the built web dist;
 *   2. <homedir>/Desktop/loam-vendor/effectcraft-web-*.zip — local cache;
 *   3. --from-source        — clone the pinned upstream rev and `cargo xtask web`.
 *
 * Nothing available is not an error: the app falls back gracefully and this
 * script prints exactly how to obtain the dist.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildFromSource,
  clearDir,
  commandExists,
  installArchive,
  installDirectory,
  isDistPresent,
  runNodeScript,
  sha256Hex,
  shouldPruneVendorFile,
  verifySha256,
  writeVendorJson,
} from './lib/vendor.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_DIST = path.join(REPO_ROOT, 'electron', 'effectcraft', 'dist');
const REBRAND_SCRIPT = path.join(REPO_ROOT, 'electron', 'effectcraft', 'rebrand.mjs');

const SOURCE_REPO = 'https://github.com/storytold/effectcraft';
const SOURCE_REV = '9db7f3b21700fd821f215782ed1c82afe077880f';
const CACHE_DIR = path.join(os.homedir(), 'Desktop', 'loam-vendor');
const ZIP_GLOB = /^effectcraft-web-.*\.zip$/i;

function parseArgs(argv) {
  const options = { force: false, fromSource: false };
  for (const arg of argv) {
    if (arg === '--force') options.force = true;
    else if (arg === '--from-source') options.fromSource = true;
  }
  return options;
}

function resolveDist(explicit, env, fallback) {
  const value = explicit || env;
  return path.resolve(value || fallback);
}

function findCachedZip(cacheDir) {
  let entries;
  try {
    entries = fs.readdirSync(cacheDir);
  } catch {
    return null;
  }
  const match = entries.filter((name) => ZIP_GLOB.test(name)).sort().pop();
  return match ? path.join(cacheDir, match) : null;
}

/**
 * Materialize the vendored dist.
 * @returns {{skipped: boolean, distDir: string, files: string[], reason?: string}}
 */
export async function runEffectcraftFetch(options = {}) {
  const distDir = resolveDist(options.distDir, process.env.LOAM_EFFECTCRAFT_DIST, DEFAULT_DIST);

  if (!options.force && isDistPresent(distDir)) {
    console.log(`effectcraft: dist already present at ${distDir} (use --force to replace)`);
    return { skipped: true, distDir, files: [], reason: 'already-present' };
  }

  let files;
  let meta;

  if (options.fromSource) {
    if (!commandExists('cargo')) {
      return unavailable(
        distDir,
        'building EffectCraft from source requires cargo (Rust). Install Rust, ' +
          'the wasm32-unknown-unknown target and wasm-bindgen-cli, then re-run with --from-source.'
      );
    }
    const repoDir = buildFromSource({
      repoUrl: options.repoUrl || SOURCE_REPO,
      rev: options.rev || SOURCE_REV,
      cacheRoot: options.cacheRoot || path.join(REPO_ROOT, '.cache', 'vendor'),
    });
    clearDir(distDir);
    files = installDirectory(repoDir, distDir, { prune: shouldPruneVendorFile });
    meta = {
      source: `${options.repoUrl || SOURCE_REPO}@${options.rev || SOURCE_REV}`,
      version: options.rev || SOURCE_REV,
      sha256: options.rev || SOURCE_REV,
      fetchedAt: new Date().toISOString(),
    };
  } else {
    const zipPath =
      options.zipPath || process.env.LOAM_EFFECTCRAFT_ZIP || findCachedZip(options.cacheDir || CACHE_DIR);
    if (!zipPath) {
      return unavailable(
        distDir,
        'no EffectCraft web dist found. Provide one with LOAM_EFFECTCRAFT_ZIP, drop ' +
          'effectcraft-web-*.zip into ~/Desktop/loam-vendor, or run with --from-source ' +
          '(requires cargo). Loam Video will fall back gracefully until then.'
      );
    }
    const file = path.resolve(zipPath);
    if (!fs.existsSync(file)) throw new Error(`EffectCraft zip not found: ${file}`);
    const buf = fs.readFileSync(file);
    const sha256 = String(options.sha256 || process.env.LOAM_EFFECTCRAFT_SHA256 || '').trim().toLowerCase();
    verifySha256(sha256Hex(buf), sha256);
    clearDir(distDir);
    files = installArchive(buf, distDir, { prune: shouldPruneVendorFile });
    meta = {
      source: `file:${file}`,
      version: path.basename(file).replace(/\.zip$/i, ''),
      sha256: sha256 || sha256Hex(buf),
      fetchedAt: new Date().toISOString(),
    };
  }

  if (files.length === 0) {
    throw new Error(`effectcraft: archive contained no files for ${distDir}`);
  }

  writeVendorJson(distDir, meta);

  if (fs.existsSync(REBRAND_SCRIPT)) {
    console.log('effectcraft: applying "Loam Effects" branding');
    runNodeScript(REBRAND_SCRIPT, [distDir]);
  }

  console.log(`effectcraft: installed ${files.length} files into ${distDir}`);
  return { skipped: false, distDir, files };
}

function unavailable(distDir, message) {
  console.log(`effectcraft: ${message}`);
  console.log(`effectcraft: no dist installed at ${distDir}`);
  return { skipped: true, distDir, files: [], reason: message };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await runEffectcraftFetch(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`effectcraft: ${err.message}`);
    process.exitCode = 1;
  });
}
