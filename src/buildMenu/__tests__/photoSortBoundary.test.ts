import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPhotoStore } = require('../../templates/electron-app/electron/apps/photoStore.cjs') as {
  createPhotoStore: (rootDirectory: string) => {
    sort: () => { files: Array<{ name: string }>; sortedCount: number };
  };
};

type Fixture = {
  parent: string;
  root: string;
  outside: string;
  secret: string;
};

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function withFixture(prefix: string, run: (fixture: Fixture) => void): void {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const root = path.join(parent, 'root');
  const outside = path.join(parent, 'outside');
  const secret = path.join(outside, 'secret.txt');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(secret, 'secret');
  try {
    run({ parent, root, outside, secret });
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function assertOutsideUntouched(fixture: Fixture): void {
  assert.deepEqual(fs.readdirSync(fixture.outside).sort(), ['secret.txt']);
  assert.equal(fs.readFileSync(fixture.secret, 'utf8'), 'secret');
  assert.deepEqual(fs.readdirSync(fixture.parent).sort(), ['outside', 'root']);
}

function assertInsideSorted(root: string, file: string): void {
  const sorted = path.resolve(root, 'sorted');
  const resolved = path.resolve(file);
  const relative = path.relative(sorted, resolved);
  assert.equal(relative.length > 0, true);
  assert.equal(relative.startsWith('..'), false);
  assert.equal(path.isAbsolute(relative), false);
  assert.equal(samePath(path.dirname(resolved), sorted), true);
  const stat = fs.lstatSync(resolved);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
}

function symlinkStat(directory: boolean): fs.Stats {
  return {
    isFile: () => !directory,
    isDirectory: () => directory,
    isSymbolicLink: () => true,
  } as fs.Stats;
}

function mockLstat(match: (target: string) => boolean, stat: fs.Stats): () => void {
  const original = fs.lstatSync.bind(fs);
  const patched = ((target: fs.PathLike, options?: fs.StatOptions) => {
    if (match(path.resolve(String(target)))) return stat;
    return options === undefined ? original(target) : original(target, options);
  }) as typeof fs.lstatSync;
  Object.defineProperty(fs, 'lstatSync', { value: patched });
  return () => {
    Object.defineProperty(fs, 'lstatSync', { value: original });
  };
}

test('sort copies photos only inside root/sorted', () => {
  withFixture('loam-photo-copy-', (fixture) => {
    const store = createPhotoStore(fixture.root);
    const originals = ['loam-blue.png', 'loam-green-copy.png', 'loam-green.png'];
    const before = new Map(originals.map((name) => [name, fs.readFileSync(path.join(fixture.root, name))]));
    const sorted = store.sort();
    assert.equal(sorted.sortedCount, originals.length);
    const destination = path.join(fixture.root, 'sorted');
    const copied = fs.readdirSync(destination);
    assert.equal(copied.length, originals.length);
    for (const name of copied) assertInsideSorted(fixture.root, path.join(destination, name));
    for (const name of originals) {
      assert.deepEqual(fs.readFileSync(path.join(fixture.root, name)), before.get(name));
    }
    assertOutsideUntouched(fixture);
    const again = store.sort();
    assert.equal(again.sortedCount, originals.length);
    assert.deepEqual(fs.readdirSync(destination).sort(), [...copied].sort());
    assertOutsideUntouched(fixture);
  });
});

test('sort skips a symlink photo and does not write outside the root', () => {
  withFixture('loam-photo-skip-', (fixture) => {
    const store = createPhotoStore(fixture.root);
    const linked = path.join(fixture.root, 'linked.png');
    const linkedBytes = Buffer.from('linked-target');
    fs.writeFileSync(linked, linkedBytes);
    const originalReaddir = fs.readdirSync.bind(fs);
    const originalCopy = fs.copyFileSync.bind(fs);
    fs.readdirSync = ((target: fs.PathLike, options?: { withFileTypes: true }) => {
      const entries = options === undefined ? originalReaddir(target) : originalReaddir(target, options);
      const withTypes = typeof options === 'object' && options !== null && options.withFileTypes === true;
      if (!withTypes || !samePath(path.resolve(String(target)), fixture.root)) return entries;
      return (entries as unknown as fs.Dirent[]).map((entry) => {
        if (entry.name !== 'linked.png') return entry;
        return {
          name: 'linked.png',
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => true,
        } as fs.Dirent;
      });
    }) as typeof fs.readdirSync;
    fs.copyFileSync = ((source: fs.PathLike, dest: fs.PathLike, mode?: number) => {
      if (samePath(path.resolve(String(source)), linked)) fs.writeFileSync(path.join(fixture.outside, 'followed.png'), 'followed');
      const relative = path.relative(path.resolve(fixture.root, 'sorted'), path.resolve(String(dest)));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        fs.writeFileSync(path.join(fixture.outside, 'escaped.png'), 'escaped');
      }
      return originalCopy(source, dest, mode);
    }) as typeof fs.copyFileSync;
    const restoreLstat = mockLstat((target) => samePath(target, linked), symlinkStat(false));
    try {
      assert.equal(fs.lstatSync(linked).isSymbolicLink(), true);
      const result = store.sort();
      assert.equal(result.files.some((file) => file.name === 'linked.png'), false);
      const names = fs.readdirSync(path.join(fixture.root, 'sorted'));
      assert.equal(names.some((name) => name.includes('linked.png')), false);
      for (const name of names) assertInsideSorted(fixture.root, path.join(fixture.root, 'sorted', name));
      assert.deepEqual(fs.readFileSync(linked), linkedBytes);
      assertOutsideUntouched(fixture);
    } finally {
      restoreLstat();
      fs.readdirSync = originalReaddir;
      fs.copyFileSync = originalCopy;
    }
    assert.equal(fs.lstatSync(linked).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(linked).isFile(), true);
  });
});

test('a rejected photo symlink does not write outside the root', () => {
  withFixture('loam-photo-reject-', (fixture) => {
    const store = createPhotoStore(fixture.root);
    const linked = path.join(fixture.root, 'loam-blue.png');
    const before = fs.readFileSync(linked);
    const originalCopy = fs.copyFileSync.bind(fs);
    let copied = 0;
    fs.copyFileSync = ((source: fs.PathLike, dest: fs.PathLike, mode?: number) => {
      copied += 1;
      fs.writeFileSync(path.join(fixture.outside, `escaped-${copied}.png`), 'escaped');
      return originalCopy(source, dest, mode);
    }) as typeof fs.copyFileSync;
    const restoreLstat = mockLstat((target) => samePath(target, linked), symlinkStat(false));
    try {
      assert.equal(fs.lstatSync(linked).isSymbolicLink(), true);
      assert.throws(() => store.sort(), /Symbolic links are not allowed/);
      assert.equal(copied, 0);
      assert.equal(fs.existsSync(path.join(fixture.root, 'sorted')), false);
      assert.deepEqual(fs.readFileSync(linked), before);
      assertOutsideUntouched(fixture);
    } finally {
      restoreLstat();
      fs.copyFileSync = originalCopy;
    }
    assert.equal(fs.lstatSync(linked).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(linked).isFile(), true);
  });
});

test('a symlink sorted directory does not receive copies or write outside the root', () => {
  withFixture('loam-photo-sorted-', (fixture) => {
    const store = createPhotoStore(fixture.root);
    const sorted = path.join(fixture.root, 'sorted');
    fs.mkdirSync(sorted);
    const originalCopy = fs.copyFileSync.bind(fs);
    const copies: string[] = [];
    fs.copyFileSync = ((source: fs.PathLike, dest: fs.PathLike, mode?: number) => {
      copies.push(path.resolve(String(dest)));
      fs.writeFileSync(path.join(fixture.outside, path.basename(String(dest))), 'escaped');
      return originalCopy(source, dest, mode);
    }) as typeof fs.copyFileSync;
    const restoreLstat = mockLstat((target) => samePath(target, sorted), symlinkStat(true));
    try {
      assert.equal(fs.lstatSync(sorted).isSymbolicLink(), true);
      assert.equal(fs.lstatSync(sorted).isDirectory(), true);
      assert.throws(() => store.sort(), /Symbolic links are not allowed/);
      assert.deepEqual(copies, []);
      assert.deepEqual(fs.readdirSync(sorted), []);
      assertOutsideUntouched(fixture);
    } finally {
      restoreLstat();
      fs.copyFileSync = originalCopy;
    }
    assert.equal(fs.lstatSync(sorted).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(sorted).isDirectory(), true);
  });
});
