/**
 * Registry replace (temp plus rename) and nonce writeFileSync throw unsafe_path
 * when the destination already exists and nlink is greater than 1. Outside
 * bytes stay. A missing file and a regular nlink 1 file still save. Quit
 * identity stays /^\d{1,32}$/ and ownedStopArgs stays /PID /T /F. This file
 * does not spawn taskkill or launch Electron. Hard links come from linkSync.
 * It does not create a symlink or junction.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/quitPlanHardLink.test.ts
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

const NONCE = 'a'.repeat(32);
const NEXT_NONCE = 'b'.repeat(32);
const PID = 4242;
const IDENTITY = '100';

function quitSource(): string {
  return fs.readFileSync(new URL('../widget/quitPlan.cjs', import.meta.url), 'utf8');
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

function withPair(prefix: string, run: (inside: string, outside: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const inside = path.join(root, 'inside');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(inside);
  fs.mkdirSync(outside);
  try {
    run(inside, outside);
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

function record(workspace: string, identity: string, nonce = NONCE): { pid: number; nonce: string; workspace: string; identity: string } {
  return { pid: PID, nonce, workspace, identity };
}

function writeManifest(workspace: string): string {
  const file = path.join(workspace, '.loam', 'build-menu', 'manifest.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    schemaVersion: 1,
    selection: { kind: 'widget' },
    consent: { autostart: false, publish: false },
  })}\n`);
  return file;
}

function linkOutside(outsideDir: string, destination: string, previous: Buffer): void {
  const outsideFile = path.join(outsideDir, 'outside-bytes');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(outsideFile, previous);
  fs.linkSync(outsideFile, destination);
  const stat = fs.lstatSync(destination);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink > 1, true);
  assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
}

test('quit plan keeps the digit identity and does not spawn taskkill or electron', () => {
  const source = quitSource();
  assert.match(source, /\/\^\\d\{1,32\}\$/);
  assert.match(source, /stat\.nlink > 1/);
  assert.match(source, /error\.code !== 'ENOENT'/);
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

test('a hard-linked registry throws unsafe_path before write or rename and the outside bytes stay', () => {
  withPair('loam-46-quit-registry-', (dataDir, outside) => {
    const file = registryPath(dataDir);
    const previous = Buffer.from('outside-registry-bytes');
    linkOutside(outside, file, previous);
    const names = fs.readdirSync(dataDir).sort();
    assert.deepEqual(names, ['build-menu-widgets.json']);
    const workspace = dataDir;

    assert.throws(() => rememberWidget(dataDir, record(workspace, IDENTITY)), isUnsafePath);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(path.join(outside, 'outside-bytes')), previous);
    assert.equal(fs.existsSync(`${file}.${process.pid}.tmp`), false);
    assert.deepEqual(fs.readdirSync(dataDir).sort(), names);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);

    assert.throws(() => planWidgetQuit(dataDir, () => IDENTITY), isUnsafePath);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(path.join(outside, 'outside-bytes')), previous);
    assert.equal(fs.existsSync(`${file}.${process.pid}.tmp`), false);
    assert.deepEqual(fs.readdirSync(dataDir).sort(), names);
    assert.equal(fs.lstatSync(file).ino, fs.lstatSync(path.join(outside, 'outside-bytes')).ino);
  });
});

test('a hard-linked registry temp throws unsafe_path before write and the outside bytes stay', () => {
  withPair('loam-46-quit-temp-', (dataDir, outside) => {
    const file = registryPath(dataDir);
    const temp = `${file}.${process.pid}.tmp`;
    const previous = Buffer.from('outside-temp-bytes');
    linkOutside(outside, temp, previous);
    assert.equal(fs.existsSync(file), false);

    assert.throws(() => rememberWidget(dataDir, record(dataDir, IDENTITY)), isUnsafePath);
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(fs.readFileSync(temp), previous);
    assert.deepEqual(fs.readFileSync(path.join(outside, 'outside-bytes')), previous);
    assert.equal(fs.lstatSync(temp).nlink > 1, true);
    assert.equal(fs.lstatSync(temp).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(temp).ino, fs.lstatSync(path.join(outside, 'outside-bytes')).ino);
  });
});

test('a hard-linked nonce throws unsafe_path before write and the outside bytes stay', () => {
  withPair('loam-46-quit-nonce-', (workspace, outside) => {
    const file = nonceFile(workspace);
    const previous = Buffer.from('outside-nonce-bytes');
    linkOutside(outside, file, previous);
    const names = fs.readdirSync(path.dirname(file)).sort();
    assert.deepEqual(names, ['widget-nonce']);

    assert.throws(() => writeWidgetNonce(workspace, NEXT_NONCE), isUnsafePath);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(path.join(outside, 'outside-bytes')), previous);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(file).ino, fs.lstatSync(path.join(outside, 'outside-bytes')).ino);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), names);
  });
});

test('a new registry and nonce still write and autostart stays false', () => {
  withPair('loam-46-quit-new-', (dataDir, workspace) => {
    const manifest = writeManifest(workspace);
    const manifestBytes = fs.readFileSync(manifest);
    const parsed = JSON.parse(manifestBytes.toString('utf8')) as { consent: { autostart: boolean } };
    assert.equal(parsed.consent.autostart, false);
    const file = nonceFile(workspace);
    assert.equal(fs.existsSync(file), false);
    writeWidgetNonce(workspace, NONCE);
    const createdNonce = fs.lstatSync(file);
    assert.equal(createdNonce.isSymbolicLink(), false);
    assert.equal(createdNonce.isFile(), true);
    assert.equal(createdNonce.nlink, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), `${NONCE}\n`);

    const registry = registryPath(dataDir);
    assert.equal(fs.existsSync(registry), false);
    rememberWidget(dataDir, record(workspace, IDENTITY));
    const createdRegistry = fs.lstatSync(registry);
    assert.equal(createdRegistry.isSymbolicLink(), false);
    assert.equal(createdRegistry.isFile(), true);
    assert.equal(createdRegistry.nlink, 1);
    const stored = JSON.parse(fs.readFileSync(registry, 'utf8')) as Array<{ identity: string; pid: number }>;
    assert.equal(stored[0]?.identity, IDENTITY);
    assert.match(stored[0]?.identity ?? '', /^\d{1,32}$/);

    const plan = planWidgetQuit(dataDir, () => IDENTITY);
    assert.equal(plan.ask, true);
    assert.deepEqual(plan.pids, [PID]);
    assert.equal(fs.lstatSync(registry).nlink, 1);
    assert.deepEqual(ownedStopArgs(PID), ['/PID', String(PID), '/T', '/F']);

    rememberWidget(dataDir, record(workspace, '101'));
    const replaced = fs.lstatSync(registry);
    assert.equal(replaced.isSymbolicLink(), false);
    assert.equal(replaced.isFile(), true);
    assert.equal(replaced.nlink, 1);
    const updated = JSON.parse(fs.readFileSync(registry, 'utf8')) as Array<{ identity: string }>;
    assert.equal(updated[0]?.identity, '101');
    assert.match(updated[0]?.identity ?? '', /^\d{1,32}$/);

    writeWidgetNonce(workspace, NEXT_NONCE);
    const replacedNonce = fs.lstatSync(file);
    assert.equal(replacedNonce.nlink, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), `${NEXT_NONCE}\n`);

    const beforeReject = fs.readFileSync(registry);
    assert.throws(() => rememberWidget(dataDir, record(workspace, 'loam-widget.exe')), /invalid_request/);
    assert.throws(() => rememberWidget(dataDir, record(workspace, '1'.repeat(33))), /invalid_request/);
    assert.deepEqual(fs.readFileSync(registry), beforeReject);
    assert.deepEqual(fs.readFileSync(manifest), manifestBytes);
    assert.equal(parsed.consent.autostart, false);
  });
});

test('lstat EPERM is not swallowed and the destination bytes stay', () => {
  withPair('loam-46-quit-eperm-', (dataDir, workspace) => {
    const registry = registryPath(dataDir);
    const previousRegistry = Buffer.from('{"keep":"registry"}\n');
    fs.writeFileSync(registry, previousRegistry);
    assert.equal(fs.lstatSync(registry).nlink, 1);
    const realLstatSync = fs.lstatSync;
    Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (samePath(String(target), registry)) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return realLstatSync(target, options);
    }) as typeof fs.lstatSync });
    try {
      assert.throws(() => rememberWidget(dataDir, record(workspace, IDENTITY)), isEperm);
      assert.equal(fs.existsSync(`${registry}.${process.pid}.tmp`), false);
    } finally {
      Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
    }
    assert.deepEqual(fs.readFileSync(registry), previousRegistry);
    assert.equal(fs.lstatSync(registry).nlink, 1);
    assert.equal(fs.lstatSync(registry).isFile(), true);

    const nonce = nonceFile(workspace);
    const previousNonce = Buffer.from('outside-nonce-eperm');
    fs.mkdirSync(path.dirname(nonce), { recursive: true });
    fs.writeFileSync(nonce, previousNonce);
    assert.equal(fs.lstatSync(nonce).nlink, 1);
    Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (samePath(String(target), nonce)) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return realLstatSync(target, options);
    }) as typeof fs.lstatSync });
    try {
      assert.throws(() => writeWidgetNonce(workspace, NEXT_NONCE), isEperm);
    } finally {
      Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
    }
    assert.deepEqual(fs.readFileSync(nonce), previousNonce);
    assert.equal(realLstatSync(nonce).nlink, 1);
    assert.equal(realLstatSync(nonce).isSymbolicLink(), false);
    assert.equal(realLstatSync(nonce).isFile(), true);
  });
});
