/**
 * readJson refuses an existing file whose nlink is greater than 1 before
 * readFileSync, and does not parse the outside bytes. A missing file still
 * returns the fallback. A regular nlink 1 file still parses, including a
 * password secret value. Hard links use fs.linkSync. EPERM and EACCES are rethrown.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/helpersReadHardLink.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { readJson } = require('../../templates/electron-app/electron/apps/helpers.cjs') as {
  readJson: (file: string, fallback: unknown) => unknown;
};

const helpersSource = fileURLToPath(new URL('../../templates/electron-app/electron/apps/helpers.cjs', import.meta.url));
const FALLBACK = { records: [] };
const STORED = {
  records: [{ id: '1', service: 'mail', username: 'ada', secret: 'correct-horse-battery' }],
};
const OUTSIDE = Buffer.from('outside-secret');

function isUnsafeLink(error: unknown): boolean {
  return error instanceof Error && error.message === 'Symbolic links are not allowed';
}

function isCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  if (process.platform === 'win32') return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  return resolvedLeft === resolvedRight;
}

function withPair(prefix: string, run: (root: string, outside: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}out-`));
  try {
    run(root, outside);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

function functionBody(source: string, name: string, next: string): string {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(next, start + 1);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

test('readJson checks the shared link before readFileSync and writeJsonAtomic stays', () => {
  const source = fs.readFileSync(helpersSource, 'utf8');
  const body = functionBody(source, 'readJson', 'function writeJsonAtomic');
  const guardAt = body.indexOf('refuseSharedLink(file)');
  const readAt = body.indexOf('fs.readFileSync');
  assert.ok(guardAt >= 0);
  assert.ok(readAt > guardAt);
  assert.match(body, /if \(!fs\.existsSync\(file\)\) return fallback;/);
  assert.equal(body.includes('catch'), false);
  assert.equal(body.includes('EPERM'), false);
  assert.equal(body.includes('EACCES'), false);
  assert.equal(body.includes('secret'), false);
  assert.equal(body.includes('password'), false);
  assert.equal(body.includes('symlinkSync'), false);
  assert.equal(body.includes('junction'), false);
  const shared = functionBody(source, 'refuseSharedLink', 'function resolveFile');
  assert.match(shared, /stat\.nlink > 1/);
  assert.match(shared, /!== 'ENOENT'/);
  assert.equal(shared.includes('EPERM'), false);
  assert.equal(shared.includes('EACCES'), false);
  const writeBody = functionBody(source, 'writeJsonAtomic', 'const REMOTE_SCHEME');
  assert.match(writeBody, /refuseSharedLink\(file\)/);
  assert.equal(writeBody.includes('readFileSync'), false);
  assert.equal(writeBody.includes('secret'), false);
});

test('a missing file still returns the fallback', () => {
  withPair('loam-48-helpers-read-missing-', (root) => {
    const file = path.join(root, 'missing.json');
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(readJson(file, FALLBACK), FALLBACK);
    assert.equal(fs.existsSync(file), false);
  });
});

test('a regular nlink 1 file still parses a password secret value', () => {
  withPair('loam-48-helpers-read-nlink1-', (root) => {
    const file = path.join(root, 'vault.json');
    fs.writeFileSync(file, JSON.stringify(STORED));
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    assert.deepEqual(readJson(file, FALLBACK), STORED);
    assert.equal(fs.lstatSync(file).nlink, 1);
    const parsed = readJson(file, FALLBACK) as { records: Array<{ secret: string }> };
    assert.equal(parsed.records[0]?.secret, 'correct-horse-battery');
  });
});

test('an existing file with nlink greater than 1 is refused before read and the outside bytes stay', () => {
  withPair('loam-48-helpers-read-nlink-', (root, outside) => {
    const outsideFile = path.join(outside, 'secret.json');
    const file = path.join(root, 'data.json');
    fs.writeFileSync(outsideFile, OUTSIDE);
    fs.linkSync(outsideFile, file);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
    let reads = 0;
    const realReadFileSync = fs.readFileSync;
    const patched = ((target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
      if (typeof target !== 'number' && samePath(String(target), file)) reads += 1;
      return realReadFileSync(target, options);
    }) as typeof fs.readFileSync;
    fs.readFileSync = patched;
    try {
      assert.throws(() => readJson(file, FALLBACK), isUnsafeLink);
      assert.equal(reads, 0);
    } finally {
      fs.readFileSync = realReadFileSync;
    }
    assert.deepEqual(fs.readFileSync(file), OUTSIDE);
    assert.deepEqual(fs.readFileSync(outsideFile), OUTSIDE);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
    assert.equal(fs.lstatSync(outsideFile).nlink > 1, true);
  });
});

test('readJson lets EPERM and EACCES from lstat escape', () => {
  for (const code of ['EPERM', 'EACCES'] as const) {
    withPair(`loam-48-helpers-read-${code.toLowerCase()}-`, (root) => {
      const file = path.join(root, 'vault.json');
      fs.writeFileSync(file, JSON.stringify(STORED));
      assert.equal(fs.lstatSync(file).nlink, 1);
      const realLstatSync = fs.lstatSync;
      const patched = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
        if (!samePath(String(target), file)) return realLstatSync(target, options);
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      }) as typeof fs.lstatSync;
      Object.defineProperty(fs, 'lstatSync', { value: patched });
      try {
        assert.throws(() => readJson(file, FALLBACK), isCode(code));
        assert.equal(realLstatSync(file).nlink, 1);
      } finally {
        Object.defineProperty(fs, 'lstatSync', { value: realLstatSync });
      }
      assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(STORED));
    });
  }
});
