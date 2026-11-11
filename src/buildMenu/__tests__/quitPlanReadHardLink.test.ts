/**
 * Registry, nonce, and manifest reads throw unsafe_path when nlink is greater
 * than 1, before readFileSync, and do not return the outside bytes. A regular
 * nlink 1 file still loads. Quit identity stays /^\d{1,32}$/ and ownedStopArgs
 * stays /PID /T /F. Autostart stays false. This file does not spawn taskkill
 * or launch Electron. Hard links come from linkSync. It does not create a
 * symlink or junction. lstat EPERM is rethrown.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/quitPlanReadHardLink.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rememberWidget, planWidgetQuit, ownedStopArgs, writeWidgetNonce } = require('../widget/quitPlan.cjs') as {
  rememberWidget(dataDir: string, record: { pid: number; nonce: string; workspace: string; identity: string }): void;
  planWidgetQuit(dataDir: string, lookup: (pid: number) => string | null): { ask: boolean; pids: number[] };
  ownedStopArgs(pid: number): string[];
  writeWidgetNonce(workspace: string, nonce: string): void;
};

const NONCE = 'c'.repeat(32);
const PID = 4242;
const IDENTITY = '100';

function quitSource(): string {
  return fs.readFileSync(new URL('../widget/quitPlan.cjs', import.meta.url), 'utf8');
}

function sliceBody(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

function isUnsafePath(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM';
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  if (process.platform === 'win32') return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  return resolvedLeft === resolvedRight;
}

function withPair(prefix: string, run: (dataDir: string, workspace: string, outside: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  try {
    run(dataDir, workspace, outside);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function registryPath(dataDir: string): string {
  return path.join(dataDir, 'build-menu-widgets.json');
}

function nonceFile(workspace: string): string {
  return path.join(workspace, '.loam', 'build-menu', 'widget-nonce');
}

function manifestFile(workspace: string): string {
  return path.join(workspace, '.loam', 'build-menu', 'manifest.json');
}

function record(workspace: string): { pid: number; nonce: string; workspace: string; identity: string } {
  return { pid: PID, nonce: NONCE, workspace, identity: IDENTITY };
}

function manifestText(): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    selection: { kind: 'widget' },
    consent: { autostart: false, publish: false },
    marker: 'outside-manifest-bytes',
  })}\n`;
}

function writeManifest(workspace: string): string {
  const file = manifestFile(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, manifestText());
  return file;
}

function registryText(workspace: string): string {
  return `${JSON.stringify([record(workspace)])}\n`;
}

function linkOutside(outsideDir: string, destination: string, previous: Buffer): string {
  const outsideFile = path.join(outsideDir, 'outside-bytes');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(outsideFile, previous);
  fs.linkSync(outsideFile, destination);
  const stat = fs.lstatSync(destination);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink > 1, true);
  assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
  return outsideFile;
}

function assertUnread(file: string, run: () => void): void {
  const realRead = fs.readFileSync;
  let seen = false;
  fs.readFileSync = ((target: fs.PathLike, ...args: unknown[]) => {
    if (samePath(String(target), file)) seen = true;
    return (realRead as (...all: unknown[]) => unknown)(target, ...args);
  }) as typeof fs.readFileSync;
  try {
    assert.throws(run, isUnsafePath);
  } finally {
    fs.readFileSync = realRead;
  }
  assert.equal(seen, false);
}

function installRegular(dataDir: string, workspace: string): void {
  writeManifest(workspace);
  writeWidgetNonce(workspace, NONCE);
  rememberWidget(dataDir, record(workspace));
}

test('quit reads refuse nlink before readFileSync and keep the stop contract', () => {
  const source = quitSource();
  const guard = sliceBody(source, 'function readRegularStat', 'function readText');
  const records = sliceBody(source, 'function readRecords', 'function refuseSharedDestination');
  const nonce = sliceBody(source, 'function nonceMatches', 'function manifestIsWidget');
  const manifest = sliceBody(source, 'function manifestIsWidget', 'function rememberWidget');
  const writes = sliceBody(source, 'function refuseSharedDestination', 'function noncePath');
  const writeBody = sliceBody(source, 'function writeRecords', 'function noncePath');
  assert.match(guard, /stat\.nlink > 1/);
  assert.match(guard, /error\.code !== 'ENOENT'/);
  assert.equal(guard.includes('readFileSync'), false);
  assert.ok(records.indexOf('readRegularStat') < records.indexOf('readText'));
  assert.ok(nonce.indexOf('readRegularStat') < nonce.indexOf('readText'));
  assert.ok(manifest.indexOf('readRegularStat') < manifest.indexOf('readText'));
  assert.match(writes, /stat\.nlink > 1/);
  assert.match(writes, /error\.code !== 'ENOENT'/);
  assert.ok(writeBody.indexOf('refuseSharedDestination(file)') < writeBody.indexOf('fs.writeFileSync'));
  assert.ok(writeBody.indexOf('fs.writeFileSync') < writeBody.lastIndexOf('refuseSharedDestination(file)'));
  assert.ok(writeBody.lastIndexOf('refuseSharedDestination(file)') < writeBody.indexOf('fs.renameSync'));
  assert.match(source, /\/\^\\d\{1,32\}\$/);
  assert.match(source, /\['\/PID', String\(pid\), '\/T', '\/F'\]/);
  assert.equal(source.includes('EPERM'), false);
  assert.equal(source.toLowerCase().includes('taskkill'), false);
  assert.equal(source.toLowerCase().includes('electron'), false);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.toLowerCase().includes('junction'), false);
  const args = ownedStopArgs(PID);
  assert.deepEqual(args, ['/PID', String(PID), '/T', '/F']);
  assert.equal(args.includes('/IM'), false);
  assert.match(IDENTITY, /^\d{1,32}$/);
  assert.equal(/^\d{1,32}$/.test('1'.repeat(33)), false);
  assert.equal(/^\d{1,32}$/.test('loam-widget.exe'), false);
});

test('a regular nlink 1 registry, nonce, and manifest still read', () => {
  withPair('loam-48-quit-read-plain-', (dataDir, workspace) => {
    installRegular(dataDir, workspace);
    const registry = registryPath(dataDir);
    const nonce = nonceFile(workspace);
    const manifest = manifestFile(workspace);
    for (const file of [registry, nonce, manifest]) {
      const stat = fs.lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false);
      assert.equal(stat.isFile(), true);
      assert.equal(stat.nlink, 1);
    }
    const plan = planWidgetQuit(dataDir, () => IDENTITY);
    assert.equal(plan.ask, true);
    assert.deepEqual(plan.pids, [PID]);
    assert.equal(fs.readFileSync(nonce, 'utf8'), `${NONCE}\n`);
    const saved = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { consent: { autostart: boolean }; marker: string };
    assert.equal(saved.consent.autostart, false);
    assert.equal(saved.marker, 'outside-manifest-bytes');
    assert.equal(fs.lstatSync(registry).nlink, 1);
    const beforeReject = fs.readFileSync(registry);
    assert.throws(() => rememberWidget(dataDir, { ...record(workspace), identity: 'loam-widget.exe' }), /invalid_request/);
    assert.deepEqual(fs.readFileSync(registry), beforeReject);
    assert.deepEqual(ownedStopArgs(PID), ['/PID', String(PID), '/T', '/F']);
  });
});

test('a hard-linked registry throws unsafe_path before read and the outside bytes stay', () => {
  withPair('loam-48-quit-read-registry-', (dataDir, workspace, outside) => {
    writeManifest(workspace);
    writeWidgetNonce(workspace, NONCE);
    const file = registryPath(dataDir);
    const previous = Buffer.from(registryText(workspace));
    const outsideFile = linkOutside(outside, file, previous);
    assertUnread(file, () => planWidgetQuit(dataDir, () => IDENTITY));
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.equal(fs.existsSync(`${file}.${process.pid}.tmp`), false);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(file).ino, fs.lstatSync(outsideFile).ino);
    assertUnread(file, () => rememberWidget(dataDir, record(workspace)));
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.equal(fs.existsSync(`${file}.${process.pid}.tmp`), false);
  });
});

test('a hard-linked nonce throws unsafe_path before read and the outside bytes stay', () => {
  withPair('loam-48-quit-read-nonce-', (dataDir, workspace, outside) => {
    writeManifest(workspace);
    const registry = registryPath(dataDir);
    rememberWidget(dataDir, record(workspace));
    const registryBytes = fs.readFileSync(registry);
    const file = nonceFile(workspace);
    const previous = Buffer.from(`${NONCE}\n`);
    const outsideFile = linkOutside(outside, file, previous);
    assertUnread(file, () => planWidgetQuit(dataDir, () => IDENTITY));
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(fs.readFileSync(registry), registryBytes);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(file).ino, fs.lstatSync(outsideFile).ino);
    const saved = JSON.parse(fs.readFileSync(manifestFile(workspace), 'utf8')) as { consent: { autostart: boolean } };
    assert.equal(saved.consent.autostart, false);
  });
});

test('a hard-linked manifest throws unsafe_path before read and the outside bytes stay', () => {
  withPair('loam-48-quit-read-manifest-', (dataDir, workspace, outside) => {
    writeWidgetNonce(workspace, NONCE);
    rememberWidget(dataDir, record(workspace));
    const registry = registryPath(dataDir);
    const registryBytes = fs.readFileSync(registry);
    const file = manifestFile(workspace);
    const previous = Buffer.from(manifestText());
    const outsideFile = linkOutside(outside, file, previous);
    assertUnread(file, () => planWidgetQuit(dataDir, () => IDENTITY));
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(fs.readFileSync(registry), registryBytes);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(file).ino, fs.lstatSync(outsideFile).ino);
    const saved = JSON.parse(previous.toString('utf8')) as { consent: { autostart: boolean }; marker: string };
    assert.equal(saved.consent.autostart, false);
    assert.equal(saved.marker, 'outside-manifest-bytes');
  });
});

test('lstat EPERM on the registry, nonce, and manifest reads is not swallowed', () => {
  withPair('loam-48-quit-read-eperm-', (dataDir, workspace) => {
    installRegular(dataDir, workspace);
    const registry = registryPath(dataDir);
    const nonce = nonceFile(workspace);
    const manifest = manifestFile(workspace);
    const registryBytes = fs.readFileSync(registry);
    const nonceBytes = fs.readFileSync(nonce);
    const manifestBytes = fs.readFileSync(manifest);
    const realLstatSync = fs.lstatSync;
    for (const target of [registry, nonce, manifest]) {
      Object.defineProperty(fs, 'lstatSync', { value: ((file: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
        if (samePath(String(file), target)) {
          const error = new Error('operation not permitted') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
        return realLstatSync(file, options);
      }) as typeof fs.lstatSync });
      try {
        assert.throws(() => planWidgetQuit(dataDir, () => IDENTITY), isEperm);
        assert.equal(fs.existsSync(`${registry}.${process.pid}.tmp`), false);
      } finally {
        Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
      }
    }
    assert.deepEqual(fs.readFileSync(registry), registryBytes);
    assert.deepEqual(fs.readFileSync(nonce), nonceBytes);
    assert.deepEqual(fs.readFileSync(manifest), manifestBytes);
    assert.equal(realLstatSync(registry).nlink, 1);
    assert.equal(realLstatSync(nonce).nlink, 1);
    assert.equal(realLstatSync(manifest).nlink, 1);
    assert.equal(realLstatSync(manifest).isSymbolicLink(), false);
    const saved = JSON.parse(manifestBytes.toString('utf8')) as { consent: { autostart: boolean } };
    assert.equal(saved.consent.autostart, false);
  });
});
