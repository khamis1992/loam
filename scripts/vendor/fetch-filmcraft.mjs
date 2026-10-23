#!/usr/bin/env node
/*
 * fetch-filmcraft.mjs — reproducible vendoring of the "Loam Video" editor dist.
 *
 * A fresh clone runs `npm run vendor:filmcraft` and gets a working
 * electron/filmcraft/dist without manual copying:
 *   - default: pinned GitHub release zip, sha256-verified;
 *   - LOAM_FILMCRAFT_ZIP / LOAM_FILMCRAFT_URL / LOAM_FILMCRAFT_SHA256 overrides;
 *   - --from-source: build the upstream repo with `cargo xtask web`.
 *
 * The dist folder is gitignored; this script never runs during npm install.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildFromSource,
  clearDir,
  download,
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
const DEFAULT_DIST = path.join(REPO_ROOT, 'electron', 'filmcraft', 'dist');
const REBRAND_SCRIPT = path.join(REPO_ROOT, 'electron', 'filmcraft', 'rebrand.mjs');

const DEFAULT_URL = 'https://github.com/storytold/filmcraft/releases/download/v0.10.0/filmcraft-web-0.10.0.zip';
const DEFAULT_SHA256 = '47618cc373ff1306be17cfd539a33a5a5af490d3bb6722a6bc1436fcd6bf87a0';
const VERSION = '0.10.0';
const SOURCE_REPO = 'https://github.com/storytold/filmcraft';
const SOURCE_REV = 'v0.10.0';

function resolveDist(explicit, env, fallback) {
  const value = explicit || env;
  return path.resolve(value || fallback);
}

function parseArgs(argv) {
  const options = { force: false, fromSource: false };
  for (const arg of argv) {
    if (arg === '--force') options.force = true;
    else if (arg === '--from-source') options.fromSource = true;
  }
  return options;
}

async function loadArchive(options) {
  const zipPath = options.zipPath || process.env.LOAM_FILMCRAFT_ZIP;
  if (zipPath) {
    const file = path.resolve(zipPath);
    if (!fs.existsSync(file)) throw new Error(`LOAM_FILMCRAFT_ZIP not found: ${file}`);
    return { source: `file:${file}`, buf: fs.readFileSync(file) };
  }
  const url = options.url || process.env.LOAM_FILMCRAFT_URL || DEFAULT_URL;
  console.log(`filmcraft: downloading ${url}`);
  return { source: url, buf: await download(url) };
}

/**
 * Materialize the vendored dist.
 * @returns {{skipped?: boolean, distDir: string, files: string[]}}
 */
export async function runFilmcraftFetch(options = {}) {
  const distDir = resolveDist(options.distDir, process.env.LOAM_FILMCRAFT_DIST, DEFAULT_DIST);

  if (!options.force && isDistPresent(distDir)) {
    console.log(`filmcraft: dist already present at ${distDir} (use --force to replace)`);
    return { skipped: true, distDir, files: [] };
  }

  let files;
  let meta;

  if (options.fromSource) {
    const repoDir = buildFromSource({
      repoUrl: options.repoUrl || SOURCE_REPO,
      rev: options.rev || SOURCE_REV,
      cacheRoot: options.cacheRoot || path.join(REPO_ROOT, '.cache', 'vendor'),
    });
    clearDir(distDir);
    files = installDirectory(repoDir, distDir, { prune: shouldPruneVendorFile });
    meta = {
      source: `${options.repoUrl || SOURCE_REPO}@${options.rev || SOURCE_REV}`,
      version: VERSION,
      sha256: options.rev || SOURCE_REV,
      fetchedAt: new Date().toISOString(),
    };
  } else {
    const { source, buf } = await loadArchive(options);
    const sha256 = String(
      options.sha256 || process.env.LOAM_FILMCRAFT_SHA256 || DEFAULT_SHA256
    ).trim().toLowerCase();
    verifySha256(sha256Hex(buf), sha256);
    clearDir(distDir);
    files = installArchive(buf, distDir, { prune: shouldPruneVendorFile });
    meta = {
      source,
      version: VERSION,
      sha256,
      fetchedAt: new Date().toISOString(),
    };
  }

  if (files.length === 0) {
    throw new Error(`filmcraft: archive contained no files for ${distDir}`);
  }

  writeVendorJson(distDir, meta);

  if (fs.existsSync(REBRAND_SCRIPT)) {
    console.log('filmcraft: rebranding to "Loam Video"');
    runNodeScript(REBRAND_SCRIPT, [distDir]);
  }

  console.log(`filmcraft: installed ${files.length} files into ${distDir}`);
  return { skipped: false, distDir, files };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runFilmcraftFetch(options);
  if (result.skipped) process.exitCode = 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`filmcraft: ${err.message}`);
    process.exitCode = 1;
  });
}
