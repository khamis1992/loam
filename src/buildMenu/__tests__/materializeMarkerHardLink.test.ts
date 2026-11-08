import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { materialize } from '../materialize.js';

const MARKER = '{"nbformat":4,"cells":[{"id":"local-cell"}]}\n';

function isUnsafe(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isInvalid(error: unknown): boolean {
  return error instanceof Error && error.message === 'invalid_request';
}

function isCode(code: 'EPERM' | 'EACCES'): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function withPair(prefix: string, run: (workspace: string, outside: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  try {
    run(workspace, outside);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeLocal(file: string, bytes: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink, 1);
}

function linkFile(outsideDir: string, destination: string, name: string, bytes: string): string {
  const outsideFile = path.join(outsideDir, name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(outsideFile, bytes);
  fs.linkSync(outsideFile, destination);
  const linked = fs.lstatSync(destination);
  assert.equal(linked.isSymbolicLink(), false);
  assert.equal(linked.isFile(), true);
  assert.equal(linked.nlink > 1, true);
  assert.equal(linked.ino, fs.lstatSync(outsideFile).ino);
  return outsideFile;
}

function unchanged(file: string, outsideFile: string, bytes: string): void {
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), bytes);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(file).isFile(), true);
  assert.equal(fs.lstatSync(file).nlink > 1, true);
  assert.equal(fs.lstatSync(file).ino, fs.lstatSync(outsideFile).ino);
}

function absentWebsite(workspace: string): void {
  assert.equal(fs.existsSync(path.join(workspace, 'app', 'preview.html')), false);
  assert.equal(fs.existsSync(path.join(workspace, 'app', 'loam-website.json')), false);
  assert.equal(fs.existsSync(path.join(workspace, 'app', 'src', 'App.tsx')), false);
  assert.equal(fs.existsSync(path.join(workspace, 'app', 'package.json')), false);
}

function refuseLstat(file: string, code: 'EPERM' | 'EACCES', run: () => void): void {
  const real = fs.lstatSync;
  fs.lstatSync = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
    if (path.resolve(String(target)) !== path.resolve(file)) return real(target, options);
    const error = new Error('marker stat refused') as NodeJS.ErrnoException;
    error.code = code;
    throw error;
  }) as typeof fs.lstatSync;
  try {
    assert.throws(run, isCode(code));
  } finally {
    fs.lstatSync = real;
  }
}

test('markerExists refuses nlink and does not catch lstat errors', () => {
  const source = fs.readFileSync(new URL('../materialize.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function markerExists(');
  const end = source.indexOf('function electronKind(');
  const body = source.slice(start, end);
  const statOf = source.slice(source.indexOf('function statOf('), start);
  assert.equal(start >= 0 && end > start, true);
  assert.match(body, /if \(stat\.isSymbolicLink\(\) \|\| !stat\.isFile\(\) \|\| stat\.nlink > 1\) throw new Error\('unsafe_path'\)/);
  assert.equal(body.includes('catch'), false);
  assert.equal(body.includes('readFileSync'), false);
  assert.equal(body.includes('EPERM'), false);
  assert.equal(body.includes('EACCES'), false);
  assert.match(statOf, /code !== 'ENOENT'\) throw error/);
  assert.match(source.slice(source.indexOf('function keptNotebook('), source.indexOf('function keptWebsite(')), /stat\.nlink > 1/);
  assert.equal(source.includes('symlinkSync'), false);
});

test('a hard-linked marker throws unsafe_path and does not select a kind', () => {
  withPair('loam-49-marker-link-', (workspace, outside) => {
    const marker = path.join(workspace, 'app', 'notebook.ipynb');
    const outsideFile = linkFile(outside, marker, 'notebook.ipynb', MARKER);
    assert.throws(
      () => materialize({ selection: { kind: 'website', subtype: 'landing' }, workspace, title: 'موقع' }),
      isUnsafe,
    );
    unchanged(marker, outsideFile, MARKER);
    absentWebsite(workspace);
  });
});

test('a regular nlink 1 marker still selects its kind', () => {
  withPair('loam-49-marker-nlink1-', (workspace) => {
    const marker = path.join(workspace, 'app', 'notebook.ipynb');
    writeLocal(marker, MARKER);
    assert.throws(
      () => materialize({ selection: { kind: 'website', subtype: 'landing' }, workspace, title: 'موقع' }),
      isInvalid,
    );
    assert.equal(fs.readFileSync(marker, 'utf8'), MARKER);
    const stat = fs.lstatSync(marker);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    absentWebsite(workspace);
  });
});

test('lstat EPERM and EACCES on a marker are rethrown', () => {
  for (const code of ['EPERM', 'EACCES'] as const) {
    withPair(`loam-49-marker-${code}-`, (workspace) => {
      const marker = path.join(workspace, 'app', 'notebook.ipynb');
      writeLocal(marker, MARKER);
      refuseLstat(marker, code, () => materialize({
        selection: { kind: 'website', subtype: 'landing' },
        workspace,
        title: 'موقع',
      }));
      assert.equal(fs.readFileSync(marker, 'utf8'), MARKER);
      const stat = fs.lstatSync(marker);
      assert.equal(stat.isSymbolicLink(), false);
      assert.equal(stat.isFile(), true);
      assert.equal(stat.nlink, 1);
      absentWebsite(workspace);
    });
  }
});
