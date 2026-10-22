import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extractZip } from './zip.mjs';

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256File(file) {
  return sha256Hex(fs.readFileSync(file));
}

export function verifySha256(actualHex, expectedHex) {
  const expected = String(expectedHex || '').trim().toLowerCase();
  if (!expected) return;
  if (actualHex !== expected) {
    throw new Error(`sha256 mismatch: expected ${expected}, got ${actualHex}`);
  }
}

export async function download(url, { timeoutMs = 120000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`download failed for ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export function run(cmd, args, { cwd } = {}) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`command failed: ${cmd} ${args.join(' ')}\n${detail}`);
  }
  return result.stdout || '';
}

export function writeVendorJson(distDir, meta) {
  const file = path.join(distDir, '.vendor.json');
  fs.writeFileSync(file, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return file;
}

/** Shallowest directory at or below start that contains the named file. */
export function findDirContaining(start, filename, maxDepth = 3) {
  let found = null;
  const walk = (dir, depth) => {
    if (depth > maxDepth || found) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === filename)) {
      found = dir;
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(start, 0);
  return found;
}

export function isDistPresent(distDir) {
  return fs.existsSync(path.join(distDir, 'index.html'));
}

export function clearDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

const PRUNE_PATTERN = /^(readme|hosting|license|notice|attribution)([.\-_]|$)/i;

/** Owner decision: vendored licence/hosting/README files are never shipped. */
export function shouldPruneVendorFile(name) {
  const lower = name.toLowerCase();
  if (lower === '_headers' || lower === '.htaccess') return true;
  return PRUNE_PATTERN.test(lower);
}

export function copyDirContents(src, dest, { prune } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  const copied = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, entry.name);
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(from, childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (prune && prune(entry.name)) continue;
      const to = path.join(dest, childRel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      copied.push(childRel.split(path.sep).join('/'));
    }
  };
  walk(src, '');
  return copied;
}

/** Extract a zip archive and copy the web root it contains into distDir. */
export function installArchive(buf, distDir, { prune } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-vendor-'));
  try {
    extractZip(buf, tmp);
    const root = findDirContaining(tmp, 'index.html') || findDirContaining(tmp, 'manifest.json') || tmp;
    return copyDirContents(root, distDir, { prune });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Copy an already-built directory tree into distDir. */
export function installDirectory(srcDir, distDir, { prune } = {}) {
  const root = findDirContaining(srcDir, 'index.html') || findDirContaining(srcDir, 'manifest.json') || srcDir;
  return copyDirContents(root, distDir, { prune });
}

export function runNodeScript(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`node ${path.basename(script)} failed\n${detail}`);
  }
  return result.stdout || '';
}

export function commandExists(cmd) {
  const result = spawnSync(cmd, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return result.status === 0;
}

/** Clone (once) and build a vendored web app from source with `cargo xtask web`. */
export function buildFromSource({ repoUrl, rev, cacheRoot, buildArgs = ['xtask', 'web'] }) {
  if (!commandExists('cargo')) {
    throw new Error(
      `building from source requires cargo; install Rust and the wasm target ` +
        `(rustup target add wasm32-unknown-unknown) and wasm-bindgen-cli.`
    );
  }
  fs.mkdirSync(cacheRoot, { recursive: true });
  const name = repoUrl.split('/').filter(Boolean).pop().replace(/\.git$/, '');
  const repoDir = path.join(cacheRoot, name);
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    run('git', ['clone', '--quiet', repoUrl, repoDir]);
  }
  run('git', ['-C', repoDir, 'fetch', '--quiet', 'origin']);
  run('git', ['-C', repoDir, 'checkout', '--quiet', rev]);
  run('cargo', buildArgs, { cwd: repoDir });
  return repoDir;
}
