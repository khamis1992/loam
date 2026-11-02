// Loam Recorder R0 vendor build (EMBED_PLAN sections 6, 9, batch R0).
// Never runs on Loam's `npm install`. Steps:
//   1. clone the pinned upstream at manifest.rev and verify HEAD
//   2. apply removals.json + patches/*.patch, rewrite package.json deps
//   3. regenerate the lockfile and `npm ci --ignore-scripts` (no install scripts)
//   4. Windows only: build the WGC helper + compositor addon, fetch LGPL ffmpeg
//      and onnxruntime, stage vcomp (upstream node scripts, sha256-pinned)
//   5. renderer-only vite build
//   6. grep gates + `npm audit --omit=dev` (0 high/critical)
//   7. zip dist (+ bin) and write sha256
// Usage:
//   node scripts/vendor/recorder/build-recorder.mjs [--src <git url|path>] [--work <dir>]
//        [--out <dir>] [--skip-native] [--write-manifest]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildZip } from '../lib/zip.mjs';
import { sha256Hex } from '../lib/vendor.mjs';
import { runGates } from './gates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MANIFEST_PATH = path.join(HERE, 'manifest.json');
export const REMOVALS_PATH = path.join(HERE, 'removals.json');
const PATCH_DIR = path.join(HERE, 'patches');
const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

function sh(cmd, args, cwd, opts = {}) {
  console.log(`[recorder] $ ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { cwd, stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8', shell: isWin && cmd.endsWith('.cmd'), maxBuffer: 256 * 1024 * 1024 });
}

export function parseArgs(argv) {
  const a = { skipNative: !isWin, writeManifest: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--src') a.src = argv[++i];
    else if (k === '--work') a.work = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--skip-native') a.skipNative = true;
    else if (k === '--write-manifest') a.writeManifest = true;
    else throw new Error(`unknown argument: ${k}`);
  }
  return a;
}

/** Rewrites upstream package.json per removals.json. Pure; returns a new object. */
export function rewritePackageJson(pkg, removals) {
  const out = structuredClone(pkg);
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    if (!out[field]) continue;
    for (const d of removals.dropDependencies) delete out[field][d];
  }
  for (const s of removals.dropScripts || []) if (out.scripts) delete out.scripts[s];
  for (const [d, v] of Object.entries(removals.setDependencies || {})) {
    if (out.devDependencies?.[d]) out.devDependencies[d] = v; else out.dependencies[d] = v;
  }
  out.overrides = { ...(out.overrides || {}), ...(removals.overrides || {}) };
  out.name = 'loam-recorder-vendor';
  delete out.build;
  return out;
}

export function applyRemovals(root, removals) {
  for (const p of removals.deletePaths) fs.rmSync(path.join(root, p), { recursive: true, force: true });
  const patches = fs.existsSync(PATCH_DIR) ? fs.readdirSync(PATCH_DIR).filter((f) => f.endsWith('.patch')).sort() : [];
  for (const p of patches) sh('git', ['apply', '--whitespace=nowarn', path.join(PATCH_DIR, p)], root);
  const pkgFile = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  fs.writeFileSync(pkgFile, JSON.stringify(rewritePackageJson(pkg, removals), null, '\t') + '\n');
  return patches;
}

/** Counts high/critical from `npm audit --json` output. */
export function auditSeverities(auditJson) {
  const v = auditJson?.metadata?.vulnerabilities || {};
  return { critical: v.critical || 0, high: v.high || 0, moderate: v.moderate || 0, low: v.low || 0, total: v.total || 0 };
}

function zipDir(dir, prefix, entries = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) zipDir(p, `${prefix}/${ent.name}`, entries);
    else entries.push({ name: `${prefix}/${ent.name}`, data: fs.readFileSync(p) });
  }
  return entries;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const removals = JSON.parse(fs.readFileSync(REMOVALS_PATH, 'utf8'));
  const work = path.resolve(args.work || path.join(process.cwd(), '.recorder-build'));
  const out = path.resolve(args.out || path.join(work, 'out'));
  const root = path.join(work, 'src');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  sh('git', ['clone', '--quiet', args.src || manifest.repo, root], work);
  sh('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', manifest.rev], root);
  const head = sh('git', ['rev-parse', 'HEAD'], root, { capture: true }).trim();
  if (head !== manifest.rev) throw new Error(`pinned rev mismatch: ${head} != ${manifest.rev}`);

  const patches = applyRemovals(root, removals);
  fs.copyFileSync(path.join(HERE, 'vite.renderer.config.mjs'), path.join(root, 'vite.recorder.config.mjs'));

  sh(npmCmd, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--engine-strict=false'], root);
  sh(npmCmd, ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--engine-strict=false'], root);

  const binDir = path.join(root, 'recorder-bin');
  if (!args.skipNative) {
    // Upstream scripts invoked directly with node (not via npm lifecycle hooks).
    for (const s of ['build-windows-wgc-helper.mjs', 'fetch-ffmpeg.mjs', 'fetch-onnxruntime.mjs', 'stage-vcomp-runtime.mjs', 'build-windows-compositor-addon.mjs']) {
      sh(process.execPath, [path.join('scripts', s)], root);
    }
    // Every upstream native script writes into electron/native/bin/<win32-x64>.
    const nativeBin = path.join(root, 'electron', 'native', 'bin', manifest.platform);
    if (!fs.existsSync(nativeBin)) throw new Error(`native output missing: ${nativeBin}`);
    fs.cpSync(nativeBin, binDir, { recursive: true });
  }

  sh(process.execPath, [path.join('node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.recorder.config.mjs'], root);
  const dist = path.join(root, 'dist-recorder');

  const failures = runGates({ root, distDir: dist, deletePaths: removals.deletePaths });
  if (failures.length) throw new Error(`recorder gates FAILED:\n- ${failures.join('\n- ')}`);
  console.log('[recorder] gates passed');

  let auditRaw;
  try { auditRaw = sh(npmCmd, ['audit', '--omit=dev', '--json'], root, { capture: true }); }
  catch (e) { auditRaw = e.stdout; } // npm audit exits 1 when anything is found
  fs.writeFileSync(path.join(out, 'audit-omit-dev.json'), auditRaw);
  const sev = auditSeverities(JSON.parse(auditRaw));
  console.log(`[recorder] npm audit --omit=dev: ${JSON.stringify(sev)}`);
  if (sev.critical || sev.high) throw new Error(`audit gate FAILED: ${sev.critical} critical, ${sev.high} high in shipped deps`);

  const top = `loam-recorder-${manifest.short}`;
  const entries = zipDir(dist, `${top}/dist`);
  if (fs.existsSync(binDir)) zipDir(binDir, `${top}/bin/${manifest.platform}`, entries);
  const meta = { app: manifest.app, rev: manifest.rev, native: !args.skipNative, patches, audit: sev, builtAt: new Date().toISOString() };
  entries.push({ name: `${top}/.vendor.json`, data: JSON.stringify(meta, null, 2) });
  const zipName = `${top}${args.skipNative ? '-renderer' : ''}.zip`;
  const zip = buildZip(entries);
  const sha = sha256Hex(zip);
  fs.writeFileSync(path.join(out, zipName), zip);
  fs.writeFileSync(path.join(out, `${zipName}.sha256`), `${sha}  ${zipName}\n`);
  console.log(`[recorder] ${zipName} ${zip.length} bytes sha256 ${sha}`);
  if (args.writeManifest && !args.skipNative) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ ...manifest, zip: zipName, sha256: sha }, null, 2) + '\n');
  }
  return { zipName, sha, audit: sev };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(`[recorder] ${e.message}`); process.exit(1); });
}
