import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPhotoStore } = require('../../templates/electron-app/electron/apps/photoStore.cjs') as {
  createPhotoStore: (rootDirectory: string) => {
    scan: () => Array<{ name: string; sha256: string }>;
    sort: () => { files: Array<{ name: string }>; sortedCount: number };
  };
};

type Fixture = {
  parent: string;
  root: string;
  outside: string;
  secret: string;
};

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
  assert.equal(fs.readFileSync(fixture.secret, 'utf8'), 'secret');
  assert.deepEqual(fs.readdirSync(fixture.outside).sort(), ['secret.txt']);
  assert.deepEqual(fs.readdirSync(fixture.parent).sort(), ['outside', 'root']);
}

test('sort refuses a destination hard link before copy and leaves the outside bytes unchanged', () => {
  withFixture('loam-photo-nlink-', (fixture) => {
    const store = createPhotoStore(fixture.root);
    const photos = store.scan();
    assert.equal(photos.length > 0, true);
    const sorted = path.join(fixture.root, 'sorted');
    fs.mkdirSync(sorted);
    const targets = photos.map((photo) => path.join(sorted, `${photo.sha256.slice(0, 10)}-${photo.name}`));
    for (const target of targets) fs.linkSync(fixture.secret, target);
    const linked = fs.lstatSync(targets[0]!);
    const outside = fs.lstatSync(fixture.secret);
    assert.equal(linked.isSymbolicLink(), false);
    assert.equal(linked.isFile(), true);
    assert.equal(linked.nlink > 1, true);
    assert.equal(linked.dev, outside.dev);
    assert.equal(linked.ino, outside.ino);
    const originalCopy = fs.copyFileSync.bind(fs);
    let copies = 0;
    fs.copyFileSync = ((source: fs.PathLike, destination: fs.PathLike, mode?: number) => {
      copies += 1;
      return originalCopy(source, destination, mode);
    }) as typeof fs.copyFileSync;
    try {
      assert.throws(
        () => store.sort(),
        (error: unknown) => error instanceof Error && error.message === 'Symbolic links are not allowed',
      );
      assert.equal(copies, 0);
      assertOutsideUntouched(fixture);
      for (const target of targets) assert.equal(fs.readFileSync(target, 'utf8'), 'secret');
    } finally {
      fs.copyFileSync = originalCopy;
    }
  });
});

test('sort copies a photo into root/sorted when the destination nlink is 1', () => {
  withFixture('loam-photo-copy-nlink-', (fixture) => {
    const store = createPhotoStore(fixture.root);
    const originals = fs.readdirSync(fixture.root);
    const before = new Map(originals.map((name) => [name, fs.readFileSync(path.join(fixture.root, name))]));
    const sorted = store.sort();
    assert.equal(sorted.sortedCount, originals.length);
    const destination = path.join(fixture.root, 'sorted');
    const copied = fs.readdirSync(destination);
    assert.equal(copied.length, originals.length);
    for (const name of copied) {
      const file = path.join(destination, name);
      const stat = fs.lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false);
      assert.equal(stat.isFile(), true);
      assert.equal(stat.nlink, 1);
      const sourceName = name.slice(11);
      const sourceBytes = before.get(sourceName);
      assert.ok(sourceBytes);
      assert.deepEqual(fs.readFileSync(file), sourceBytes);
    }
    const again = store.sort();
    assert.equal(again.sortedCount, originals.length);
    for (const name of fs.readdirSync(destination)) {
      assert.equal(fs.lstatSync(path.join(destination, name)).nlink, 1);
    }
    assertOutsideUntouched(fixture);
  });
});
