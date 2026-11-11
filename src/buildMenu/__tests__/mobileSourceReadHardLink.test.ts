/**
 * Worktree manifest and generated-file reads throw unsafe_path when nlink is
 * greater than 1, before readFileSync. Outside bytes are not hashed or
 * returned, and a hard-linked file is not unlinked. A regular nlink 1 file
 * still reads. Hard links use fs.linkSync. Remote-scheme, secret-filename,
 * and write-side nlink refusals stay. This file does not create a symlink or
 * junction, write an apk, run Gradle, or catch EPERM.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/mobileSourceReadHardLink.test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { materialize } from '../materialize.js';
import { materializeSource, writeWorktreeFile } from '../../mobile/source.js';

const FRESH = 'const marker="fresh-worktree";\n';
const OUTSIDE_MANIFEST = 'outside-manifest-secret';
const OUTSIDE_GENERATED = 'outside-generated-secret';
const OUTSIDE_STALE = 'outside-stale-secret';
const STALE = 'stale-local-bytes';
const STALE_NAME = 'web/stale.js';

function refused(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isAssertion(error: unknown): boolean {
  return error instanceof Error && error.name === 'AssertionError';
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EPERM';
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function pair(prefix: string): { root: string; outside: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}out-`));
  return { root, outside };
}

function removePair(root: string, outside: string): void {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

function worktreeFile(root: string, name: string): string {
  return path.join(root, '.loam', 'mobile-worktree', ...name.split('/'));
}

function manifestFile(root: string): string {
  return path.join(root, '.loam', 'mobile-worktree-manifest.json');
}

function plant(outside: string, destination: string, bytes: Buffer): string {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const outsideFile = path.join(outside, path.basename(destination));
  fs.writeFileSync(outsideFile, bytes);
  fs.linkSync(outsideFile, destination);
  return outsideFile;
}

function assertLinked(file: string, outsideFile: string): void {
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink > 1, true);
  assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
  assert.equal(fs.lstatSync(outsideFile).nlink > 1, true);
}

function assertPlain(file: string): void {
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink, 1);
}

function apkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const absolute = path.join(dir, item.name);
    if (item.isDirectory()) found.push(...apkFiles(absolute));
    else if (item.isFile() && item.name.toLowerCase().endsWith('.apk')) found.push(absolute);
  }
  return found;
}

function sliceBetween(source: string, startMark: string, endMark: string): string {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start + startMark.length);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

function project(root: string): void {
  materialize({ selection: { kind: 'mobile' }, workspace: root, title: 'جوال' });
}

function countReads(files: string[]): { count: (file: string) => number; raw: typeof fs.readFileSync; restore: () => void } {
  const wanted = new Map(files.map((file) => [path.resolve(file), 0]));
  const raw = fs.readFileSync;
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, options?: unknown) => {
    if (typeof target !== 'number') {
      const key = path.resolve(String(target));
      if (wanted.has(key)) wanted.set(key, (wanted.get(key) ?? 0) + 1);
    }
    return raw(target, options as never);
  }) as typeof fs.readFileSync;
  return {
    count: (file: string) => wanted.get(path.resolve(file)) ?? 0,
    raw,
    restore: () => { fs.readFileSync = raw; },
  };
}

function epermOnSecondStat(file: string): { hits: () => number; restore: () => void } {
  const resolved = path.resolve(file);
  const real = fs.lstatSync;
  let hits = 0;
  Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
    if (path.resolve(String(target)) === resolved) {
      hits += 1;
      if (hits > 1) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
    }
    return real(target, options);
  }) as typeof fs.lstatSync });
  return { hits: () => hits, restore: () => { Object.defineProperty(fs, 'lstatSync', { value: real }); } };
}

async function expectRefusal(run: () => Promise<unknown>, secret: string): Promise<void> {
  try {
    const value = await run();
    assert.fail(`returned ${JSON.stringify(value).includes(secret)}`);
  } catch (error) {
    if (isAssertion(error)) throw error;
    assert.equal(refused(error), true);
    assert.equal(String(error).includes(secret), false);
  }
}

function expectSyncRefusal(run: () => void, secret: string): void {
  try {
    run();
    assert.fail('expected unsafe_path');
  } catch (error) {
    if (isAssertion(error)) throw error;
    assert.equal(refused(error), true);
    assert.equal(String(error).includes(secret), false);
  }
}

test('manifest and generated reads refuse nlink before readFileSync and keep the other refusals', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../../mobile/source.ts', import.meta.url)), 'utf8');
  const materializeBody = sliceBetween(source, 'export async function materializeSource', 'export function writeWorktreeFile');
  const writeBody = sliceBetween(source, 'export function writeWorktreeFile', 'export async function sourceExport');
  const exportBody = source.slice(source.indexOf('export async function sourceExport'));
  const staleAt = materializeBody.indexOf('Object.keys(previous)');
  const staleGuard = materializeBody.indexOf('refuseSharedDestination(', staleAt);
  const staleRead = materializeBody.indexOf('fs.readFileSync(', staleAt);
  const staleUnlink = materializeBody.indexOf('fs.unlinkSync(', staleAt);
  const hashed = materializeBody.indexOf('hash(fs.readFileSync(target');
  const hashGuard = materializeBody.lastIndexOf('refuseSharedDestination(', hashed);
  const wrote = writeBody.indexOf('fs.writeFileSync(');
  const writeGuard = writeBody.indexOf('refuseSharedDestination(', wrote);
  const writeRead = writeBody.indexOf('fs.readFileSync(', wrote);
  assert.equal(materializeBody.indexOf('refuseSharedDestination(') < materializeBody.indexOf('fs.readFileSync('), true);
  assert.equal(materializeBody.indexOf('refuseSharedDestination(') < materializeBody.indexOf('fs.writeFileSync('), true);
  assert.ok(hashGuard >= 0 && hashGuard < hashed);
  assert.ok(staleAt >= 0 && staleGuard > staleAt && staleRead > staleGuard && staleUnlink > staleRead);
  assert.equal(writeBody.indexOf('refuseSharedDestination(') < wrote, true);
  assert.ok(writeGuard > wrote && writeRead > writeGuard);
  assert.equal((source.match(/stat\.nlink > 1/g) ?? []).length, 1);
  assert.match(exportBody, /remoteWebFile\(/);
  assert.match(exportBody, /secretFile\(/);
  assert.match(exportBody, /packedSecret\(/);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('junction'), false);
  assert.equal(source.includes('EPERM'), false);
  assert.equal(/gradle/i.test(source), false);
  assert.equal(source.includes('.apk'), false);
});

test('a hard-linked manifest throws unsafe_path before read and the outside bytes stay', async () => {
  const { root, outside } = pair('loam-48-mobile-manifest-');
  const manifest = manifestFile(root);
  const outsideBytes = Buffer.from(OUTSIDE_MANIFEST);
  try {
    project(root);
    const outsideFile = plant(outside, manifest, outsideBytes);
    assertLinked(manifest, outsideFile);
    const reads = countReads([manifest]);
    try {
      await expectRefusal(() => materializeSource(root, 'task-source'), OUTSIDE_MANIFEST);
      assert.equal(reads.count(manifest), 0);
    } finally {
      reads.restore();
    }
    assert.deepEqual(reads.raw(manifest), outsideBytes);
    assert.deepEqual(reads.raw(outsideFile), outsideBytes);
    assertLinked(manifest, outsideFile);
    assert.deepEqual(apkFiles(root), []);
  } finally {
    removePair(root, outside);
  }
});

test('a hard-linked manifest throws unsafe_path before writeWorktreeFile reads it', () => {
  const { root, outside } = pair('loam-48-mobile-write-manifest-');
  const manifest = manifestFile(root);
  const outsideBytes = Buffer.from(OUTSIDE_MANIFEST);
  try {
    const outsideFile = plant(outside, manifest, outsideBytes);
    assertLinked(manifest, outsideFile);
    const reads = countReads([manifest]);
    try {
      expectSyncRefusal(() => writeWorktreeFile(root, 'web/app.js', FRESH), OUTSIDE_MANIFEST);
      assert.equal(reads.count(manifest), 0);
    } finally {
      reads.restore();
    }
    assert.deepEqual(fs.readFileSync(manifest), outsideBytes);
    assert.deepEqual(fs.readFileSync(outsideFile), outsideBytes);
    assertLinked(manifest, outsideFile);
    assert.deepEqual(apkFiles(root), []);
  } finally {
    removePair(root, outside);
  }
});

test('a hard-linked generated file throws unsafe_path before it is hashed', async () => {
  const { root, outside } = pair('loam-48-mobile-generated-');
  const file = worktreeFile(root, 'web/app.js');
  const outsideBytes = Buffer.from(OUTSIDE_GENERATED);
  try {
    project(root);
    const outsideFile = plant(outside, file, outsideBytes);
    assertLinked(file, outsideFile);
    const reads = countReads([file]);
    try {
      await expectRefusal(() => materializeSource(root, 'task-source', true), OUTSIDE_GENERATED);
      assert.equal(reads.count(file), 0);
    } finally {
      reads.restore();
    }
    assert.deepEqual(fs.readFileSync(file), outsideBytes);
    assert.deepEqual(fs.readFileSync(outsideFile), outsideBytes);
    assertLinked(file, outsideFile);
    assert.equal(fs.existsSync(manifestFile(root)), false);
    assert.deepEqual(apkFiles(root), []);
  } finally {
    removePair(root, outside);
  }
});

test('a hard-linked stale file is not read, hashed, or unlinked', async () => {
  const { root, outside } = pair('loam-48-mobile-stale-');
  const file = worktreeFile(root, STALE_NAME);
  const outsideBytes = Buffer.from(OUTSIDE_STALE);
  try {
    project(root);
    const created = await materializeSource(root, 'task-source');
    assert.equal(Object.hasOwn(created.files, STALE_NAME), false);
    const outsideFile = plant(outside, file, outsideBytes);
    assertLinked(file, outsideFile);
    const manifest = JSON.parse(fs.readFileSync(manifestFile(root), 'utf8')) as Record<string, string>;
    manifest[STALE_NAME] = sha(OUTSIDE_STALE);
    fs.writeFileSync(manifestFile(root), JSON.stringify(manifest));
    const before = fs.readFileSync(manifestFile(root));
    const reads = countReads([file]);
    try {
      await expectRefusal(() => materializeSource(root, 'task-source'), OUTSIDE_STALE);
      assert.equal(reads.count(file), 0);
    } finally {
      reads.restore();
    }
    assert.deepEqual(fs.readFileSync(file), outsideBytes);
    assert.deepEqual(fs.readFileSync(outsideFile), outsideBytes);
    assert.deepEqual(fs.readFileSync(manifestFile(root)), before);
    assertLinked(file, outsideFile);
    assert.deepEqual(apkFiles(root), []);
  } finally {
    removePair(root, outside);
  }
});

test('force does not unlink a hard-linked stale file or read it', async () => {
  const { root, outside } = pair('loam-48-mobile-stale-force-');
  const file = worktreeFile(root, STALE_NAME);
  const outsideBytes = Buffer.from(OUTSIDE_STALE);
  try {
    project(root);
    await materializeSource(root, 'task-source');
    const outsideFile = plant(outside, file, outsideBytes);
    assertLinked(file, outsideFile);
    const manifest = JSON.parse(fs.readFileSync(manifestFile(root), 'utf8')) as Record<string, string>;
    manifest[STALE_NAME] = sha('different-hash-input');
    fs.writeFileSync(manifestFile(root), JSON.stringify(manifest));
    const reads = countReads([file]);
    try {
      await expectRefusal(() => materializeSource(root, 'task-source', true), OUTSIDE_STALE);
      assert.equal(reads.count(file), 0);
    } finally {
      reads.restore();
    }
    assert.deepEqual(fs.readFileSync(file), outsideBytes);
    assert.deepEqual(fs.readFileSync(outsideFile), outsideBytes);
    assertLinked(file, outsideFile);
    assert.deepEqual(apkFiles(root), []);
  } finally {
    removePair(root, outside);
  }
});

test('a regular nlink 1 manifest and generated file still read', async () => {
  const { root, outside } = pair('loam-48-mobile-plain-');
  const generated = worktreeFile(root, 'web/app.js');
  const stale = worktreeFile(root, STALE_NAME);
  const manifest = manifestFile(root);
  try {
    project(root);
    const created = await materializeSource(root, 'task-source');
    assertPlain(generated);
    assertPlain(manifest);
    assert.equal(fs.readFileSync(generated, 'utf8'), created.files['web/app.js']);
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, STALE);
    assertPlain(stale);
    const saved = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<string, string>;
    saved[STALE_NAME] = sha(STALE);
    fs.writeFileSync(manifest, JSON.stringify(saved));
    assertPlain(manifest);
    const reads = countReads([manifest, generated, stale]);
    let again: Awaited<ReturnType<typeof materializeSource>> | undefined;
    try {
      again = await materializeSource(root, 'task-source');
      assert.equal(reads.count(manifest) > 0, true);
      assert.equal(reads.count(generated) > 0, true);
      assert.equal(reads.count(stale), 1);
    } finally {
      reads.restore();
    }
    assert.ok(again);
    assert.equal(JSON.stringify(again).includes(STALE), false);
    assert.equal(fs.existsSync(stale), false);
    assertPlain(generated);
    assert.equal(fs.readFileSync(generated, 'utf8'), again.files['web/app.js']);
    assertPlain(manifest);
    const kept = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<string, string>;
    assert.equal(Object.hasOwn(kept, STALE_NAME), false);
    fs.writeFileSync(manifest, JSON.stringify({ 'web/kept.js': 'kept-hash' }));
    assertPlain(manifest);
    writeWorktreeFile(root, 'web/app.js', FRESH);
    const merged = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<string, string>;
    assert.equal(merged['web/kept.js'], 'kept-hash');
    assert.equal(merged['web/app.js'], sha(FRESH));
    assertPlain(manifest);
    assertPlain(worktreeFile(root, 'web/app.js'));
    assert.equal(fs.readFileSync(worktreeFile(root, 'web/app.js'), 'utf8'), FRESH);
    assert.deepEqual(apkFiles(root), []);
  } finally {
    removePair(root, outside);
  }
});

test('lstat EPERM on the manifest is not swallowed before the read', async () => {
  const { root, outside } = pair('loam-48-mobile-manifest-eperm-');
  const manifest = manifestFile(root);
  const body = Buffer.from('{"web/kept.js":"kept-hash"}');
  try {
    project(root);
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, body);
    assertPlain(manifest);
    const reads = countReads([manifest]);
    const stats = epermOnSecondStat(manifest);
    try {
      await assert.rejects(materializeSource(root, 'task-source'), isEperm);
      assert.equal(reads.count(manifest), 0);
      assert.equal(stats.hits() > 1, true);
    } finally {
      reads.restore();
      stats.restore();
    }
    assert.deepEqual(fs.readFileSync(manifest), body);
    assertPlain(manifest);
    assert.deepEqual(apkFiles(root), []);
  } finally {
    removePair(root, outside);
  }
});

test('lstat EPERM on a generated file is not swallowed before the read or unlink', async () => {
  const { root, outside } = pair('loam-48-mobile-stale-eperm-');
  const stale = worktreeFile(root, STALE_NAME);
  try {
    project(root);
    await materializeSource(root, 'task-source');
    fs.writeFileSync(stale, STALE);
    assertPlain(stale);
    const manifest = JSON.parse(fs.readFileSync(manifestFile(root), 'utf8')) as Record<string, string>;
    manifest[STALE_NAME] = sha(STALE);
    fs.writeFileSync(manifestFile(root), JSON.stringify(manifest));
    const before = fs.readFileSync(manifestFile(root));
    const reads = countReads([stale]);
    const stats = epermOnSecondStat(stale);
    try {
      await assert.rejects(materializeSource(root, 'task-source'), isEperm);
      assert.equal(reads.count(stale), 0);
      assert.equal(stats.hits() > 1, true);
    } finally {
      reads.restore();
      stats.restore();
    }
    assert.equal(fs.readFileSync(stale, 'utf8'), STALE);
    assertPlain(stale);
    assert.deepEqual(fs.readFileSync(manifestFile(root)), before);
    assert.deepEqual(apkFiles(root), []);
  } finally {
    removePair(root, outside);
  }
});
