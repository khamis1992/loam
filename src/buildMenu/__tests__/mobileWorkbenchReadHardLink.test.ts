/**
 * Release catalog, release document, and worktree import reads throw
 * unsafe_path when nlink is greater than 1, before readFileSync. Outside
 * bytes are not parsed or returned. A regular nlink 1 file still reads.
 * EPERM and EACCES from lstat are rethrown. Hard links use fs.linkSync.
 * The UI_DIR mobile-sandbox.js read stays. This file does not listen, start
 * a server, write an apk, run Gradle, or create a symlink or junction.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/mobileWorkbenchReadHardLink.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readMobileReleaseDocument, readMobileReleases, readMobileWorktreeImport } from '../../mobile/workbench-http.js';

const CATALOG_SECRET = 'outside-catalog-secret';
const RELEASE_SECRET = 'outside-release-secret';
const IMPORT_SECRET = 'outside-import-secret';
const RELEASE_ID = 'rel1';
const IMPORT_NAME = 'web/app.js';
const CATALOG = {
  active: RELEASE_ID,
  items: [{ id: RELEASE_ID, label: 'محلي', createdAt: '2026-01-01T00:00:00.000Z', revision: 1 }],
};
const DOCUMENT = { project: { title: 'دفتر' }, files: { 'web/index.html': '<p>محلي</p>' } };
const IMPORT_TEXT = 'const marker="local-import";\n';

function sourceText(): string {
  return fs.readFileSync(fileURLToPath(new URL('../../mobile/workbench-http.ts', import.meta.url)), 'utf8');
}

function sliceBetween(source: string, startMark: string, endMark: string): string {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start + startMark.length);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

function refused(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isAssertion(error: unknown): boolean {
  return error instanceof Error && error.name === 'AssertionError';
}

function isCode(code: 'EPERM' | 'EACCES'): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  if (process.platform === 'win32') return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  return resolvedLeft === resolvedRight;
}

function withPair(prefix: string, run: (root: string, outside: string) => void): void {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const root = path.join(parent, 'project');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  try {
    run(root, outside);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function catalogFile(root: string): string {
  return path.join(root, '.loam', 'mobile-releases.json');
}

function releaseFile(root: string): string {
  return path.join(root, '.loam', `mobile-release-${RELEASE_ID}.json`);
}

function importFile(root: string): string {
  return path.join(root, '.loam', 'mobile-worktree', 'web', 'app.js');
}

function plant(outside: string, destination: string, bytes: Buffer): string {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const outsideFile = path.join(outside, path.basename(destination));
  fs.writeFileSync(outsideFile, bytes);
  fs.linkSync(outsideFile, destination);
  return outsideFile;
}

function assertLinked(file: string, outsideFile: string, bytes: Buffer): void {
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink > 1, true);
  assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
  assert.equal(fs.lstatSync(outsideFile).nlink > 1, true);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readFileSync(outsideFile), bytes);
}

function assertPlain(file: string): void {
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink, 1);
}

function expectUnread(file: string, secret: string, run: () => void): void {
  const realRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (typeof target !== 'number' && samePath(String(target), file)) reads += 1;
    return realRead(target, options);
  }) as typeof fs.readFileSync;
  try {
    try {
      run();
      assert.fail('expected unsafe_path');
    } catch (error) {
      if (isAssertion(error)) throw error;
      assert.equal(refused(error), true);
      assert.equal(String(error).includes(secret), false);
    }
    assert.equal(reads, 0);
  } finally {
    fs.readFileSync = realRead;
  }
}

function expectCode(file: string, code: 'EPERM' | 'EACCES', run: () => void): void {
  const realLstat = fs.lstatSync;
  const realRead = fs.readFileSync;
  let reads = 0;
  Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
    if (samePath(String(target), file) && new Error().stack?.includes('lstatWorkspace')) {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = code;
      throw error;
    }
    return realLstat(target, options);
  }) as typeof fs.lstatSync });
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (typeof target !== 'number' && samePath(String(target), file)) reads += 1;
    return realRead(target, options);
  }) as typeof fs.readFileSync;
  try {
    assert.throws(run, isCode(code));
    assert.equal(reads, 0);
  } finally {
    Object.defineProperty(fs, 'lstatSync', { value: realLstat });
    fs.readFileSync = realRead;
  }
}

test('workspace reads refuse nlink before readFileSync and the sandbox read stays', () => {
  const source = sourceText();
  const guard = sliceBetween(source, 'function lstatWorkspace', 'export function readMobileReleases');
  const catalog = sliceBetween(source, 'export function readMobileReleases', 'export function readMobileReleaseDocument');
  const document = sliceBetween(source, 'export function readMobileReleaseDocument', 'export function readMobileWorktreeImport');
  const importer = sliceBetween(source, 'export function readMobileWorktreeImport', 'const json=');
  const preview = sliceBetween(source, 'export function previewHtml', 'export async function handleMobileWorkbench');
  const handler = source.slice(source.indexOf('export async function handleMobileWorkbench'));
  assert.match(guard, /code==='EPERM'\|\|code==='EACCES'/);
  assert.match(guard, /stat\.nlink > 1/);
  assert.match(guard, /throw new Error\('unsafe_path'\)/);
  assert.equal(guard.includes('readFileSync'), false);
  assert.ok(guard.indexOf('EPERM') < guard.indexOf('nlink > 1'));
  assert.ok(catalog.indexOf('lstatWorkspace(') < catalog.indexOf('fs.readFileSync('));
  assert.ok(catalog.indexOf("==='ENOENT'") < catalog.indexOf('fs.readFileSync('));
  assert.ok(document.indexOf('lstatWorkspace(') < document.indexOf('fs.readFileSync('));
  assert.ok(importer.indexOf('lstatWorkspace(') < importer.indexOf('size>1_500_000'));
  assert.ok(importer.indexOf('size>1_500_000') < importer.indexOf('fs.readFileSync('));
  assert.match(preview, /fs\.readFileSync\(path\.join\(UI_DIR,'mobile-sandbox\.js'\),'utf8'\)/);
  assert.equal(preview.includes('nlink'), false);
  assert.equal(preview.includes('lstatWorkspace'), false);
  assert.equal(handler.includes('fs.readFileSync'), false);
  assert.equal(handler.includes('readMobileWorktreeImport(root,body.path)'), true);
  assert.equal((handler.match(/readMobileReleaseDocument\(/g) ?? []).length, 2);
  assert.equal((handler.match(/readMobileReleases\(/g) ?? []).length, 2);
  assert.equal((source.match(/fs\.readFileSync\(/g) ?? []).length, 4);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('junction'), false);
  assert.equal(source.includes('.listen('), false);
  assert.equal(source.includes('createServer'), false);
  assert.equal(/gradle/i.test(source), false);
  assert.equal(source.includes('.apk'), false);
});

test('a hard-linked release catalog throws unsafe_path before read and the outside bytes stay', () => {
  withPair('loam-49-wb-catalog-', (root, outside) => {
    const file = catalogFile(root);
    const bytes = Buffer.from(CATALOG_SECRET);
    const outsideFile = plant(outside, file, bytes);
    assertLinked(file, outsideFile, bytes);
    expectUnread(file, CATALOG_SECRET, () => readMobileReleases(root));
    assertLinked(file, outsideFile, bytes);
  });
});

test('a hard-linked release document throws unsafe_path before read and the outside bytes stay', () => {
  withPair('loam-49-wb-release-', (root, outside) => {
    const file = releaseFile(root);
    const bytes = Buffer.from(RELEASE_SECRET);
    const outsideFile = plant(outside, file, bytes);
    assertLinked(file, outsideFile, bytes);
    expectUnread(file, RELEASE_SECRET, () => readMobileReleaseDocument(root, RELEASE_ID));
    assertLinked(file, outsideFile, bytes);
  });
});

test('a hard-linked worktree import throws unsafe_path before read and the outside bytes stay', () => {
  withPair('loam-49-wb-import-', (root, outside) => {
    const file = importFile(root);
    const bytes = Buffer.from(IMPORT_SECRET);
    const outsideFile = plant(outside, file, bytes);
    assertLinked(file, outsideFile, bytes);
    expectUnread(file, IMPORT_SECRET, () => readMobileWorktreeImport(root, IMPORT_NAME));
    assertLinked(file, outsideFile, bytes);
  });
});

test('a regular nlink 1 catalog, release document, and import still read', () => {
  withPair('loam-49-wb-nlink1-', (root) => {
    assert.deepEqual(readMobileReleases(root), { active: null, items: [] });
    const catalog = catalogFile(root);
    const release = releaseFile(root);
    const imported = importFile(root);
    fs.mkdirSync(path.dirname(catalog), { recursive: true });
    fs.mkdirSync(path.dirname(imported), { recursive: true });
    fs.writeFileSync(catalog, JSON.stringify(CATALOG));
    fs.writeFileSync(release, JSON.stringify(DOCUMENT));
    fs.writeFileSync(imported, IMPORT_TEXT);
    assertPlain(catalog);
    assertPlain(release);
    assertPlain(imported);
    assert.deepEqual(readMobileReleases(root), CATALOG);
    assert.deepEqual(readMobileReleaseDocument(root, RELEASE_ID), DOCUMENT);
    assert.equal(readMobileWorktreeImport(root, IMPORT_NAME), IMPORT_TEXT);
    assert.equal(fs.readFileSync(catalog, 'utf8').includes(CATALOG_SECRET), false);
    assert.equal(fs.readFileSync(release, 'utf8').includes(RELEASE_SECRET), false);
    assert.equal(fs.readFileSync(imported, 'utf8').includes(IMPORT_SECRET), false);
    assertPlain(catalog);
    assertPlain(release);
    assertPlain(imported);
  });
});

test('lstat EPERM and EACCES are rethrown before each workspace read', () => {
  withPair('loam-49-wb-eperm-', (root) => {
    const catalog = catalogFile(root);
    const release = releaseFile(root);
    const imported = importFile(root);
    fs.mkdirSync(path.dirname(catalog), { recursive: true });
    fs.mkdirSync(path.dirname(imported), { recursive: true });
    fs.writeFileSync(catalog, JSON.stringify(CATALOG));
    fs.writeFileSync(release, JSON.stringify(DOCUMENT));
    fs.writeFileSync(imported, IMPORT_TEXT);
    assertPlain(catalog);
    assertPlain(release);
    assertPlain(imported);
    const reads: Array<[string, () => void]> = [
      [catalog, () => readMobileReleases(root)],
      [release, () => readMobileReleaseDocument(root, RELEASE_ID)],
      [imported, () => readMobileWorktreeImport(root, IMPORT_NAME)],
    ];
    for (const code of ['EPERM', 'EACCES'] as const) {
      for (const [file, run] of reads) expectCode(file, code, run);
    }
    assert.deepEqual(readMobileReleases(root), CATALOG);
    assert.deepEqual(readMobileReleaseDocument(root, RELEASE_ID), DOCUMENT);
    assert.equal(readMobileWorktreeImport(root, IMPORT_NAME), IMPORT_TEXT);
  });
});
