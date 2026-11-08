/**
 * file() reads .loam/mobile-local/files/<id>. secret() reads
 * .loam/mobile-local/secrets.key. mutateFile unlinks a stored file on delete
 * and again if the upload row cannot be saved. Each refuses nlink greater
 * than 1 before that read or unlink. Outside bytes stay. A regular nlink 1
 * file still reads and the existing delete path still removes it. A missing
 * key is still created with flag wx. Hard links use fs.linkSync. This file
 * does not create a symlink or junction, write an apk, run Gradle, or start
 * a server. EPERM and EACCES from lstat are rethrown.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/mobileLocalReadHardLink.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MobileLocalServices } from '../../mobile/local-services.js';
import { MobileError, type MobileProject } from '../../mobile/store.js';

const LOCAL = Buffer.from('local-file-bytes');
const OUTSIDE = Buffer.from('outside-file-bytes');
const KEY_MARKER = Buffer.from('outside-key-marker');

const project: MobileProject = {
  version: 1,
  revision: 1,
  title: 'دفتر محلي',
  accent: '#177E89',
  direction: 'rtl',
  screens: [{ id: 'home', title: 'دفتر', kind: 'primary', blocks: [] }],
};

function sourceText(): string {
  return fs.readFileSync(new URL('../../mobile/local-services.ts', import.meta.url), 'utf8');
}

function refused(error: unknown): boolean {
  return error instanceof MobileError && error.message === 'unsafe_path' && error.status === 400;
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

function sliceBetween(source: string, startMark: string, endMark: string): string {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start + startMark.length);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

function withService(prefix: string, run: (service: MobileLocalServices, root: string, outside: string) => void): void {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const root = path.join(parent, 'project');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const service = new MobileLocalServices(root, project);
  try {
    run(service, root, outside);
  } finally {
    service.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function storedFile(root: string, id: string): string {
  return path.join(root, '.loam', 'mobile-local', 'files', id);
}

function keyFile(root: string): string {
  return path.join(root, '.loam', 'mobile-local', 'secrets.key');
}

function upload(service: MobileLocalServices, bytes: Buffer): string {
  const result = service.mutateFile('shared', {
    action: 'upload',
    name: 'note.txt',
    type: 'text/plain',
    data: bytes.toString('base64'),
  });
  assert.ok(result && typeof result === 'object' && 'file' in result);
  const id = result.file.id;
  assert.equal(typeof id, 'string');
  assert.match(id, /^[-\w]{36}$/);
  return id;
}

function assertPlain(file: string): void {
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink, 1);
}

function assertLinked(file: string, outsideFile: string, bytes: Buffer): void {
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.nlink > 1, true);
  assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readFileSync(outsideFile), bytes);
}

type Counts = { reads: number; unlinks: number; chmods: number; writes: number };

function watch(file: string, run: () => void): Counts {
  const realRead = fs.readFileSync;
  const realUnlink = fs.unlinkSync;
  const realChmod = fs.chmodSync;
  const realWrite = fs.writeFileSync;
  const counts: Counts = { reads: 0, unlinks: 0, chmods: 0, writes: 0 };
  const hit = (target: fs.PathLike | fs.PathOrFileDescriptor) => typeof target !== 'number' && samePath(String(target), file);
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (hit(target)) counts.reads += 1;
    return realRead(target, options);
  }) as typeof fs.readFileSync;
  fs.unlinkSync = ((target: fs.PathLike) => {
    if (hit(target)) counts.unlinks += 1;
    return realUnlink(target);
  }) as typeof fs.unlinkSync;
  fs.chmodSync = ((target: fs.PathLike, mode: fs.Mode) => {
    if (hit(target)) counts.chmods += 1;
    return realChmod(target, mode);
  }) as typeof fs.chmodSync;
  fs.writeFileSync = ((target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
    if (hit(target)) counts.writes += 1;
    return realWrite(target, data, options);
  }) as typeof fs.writeFileSync;
  try {
    run();
    return counts;
  } finally {
    fs.readFileSync = realRead;
    fs.unlinkSync = realUnlink;
    fs.chmodSync = realChmod;
    fs.writeFileSync = realWrite;
  }
}

function gateLstat(file: string, failAt: number, code: 'EPERM' | 'EACCES'): { restore: () => void; seen: () => number } {
  const real = fs.lstatSync;
  let seen = 0;
  fs.lstatSync = ((target: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
    if (samePath(String(target), file)) {
      seen += 1;
      if (seen >= failAt) {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      }
    }
    return real(target, options);
  }) as typeof fs.lstatSync;
  return {
    restore: () => {
      fs.lstatSync = real;
    },
    seen: () => seen,
  };
}

test('the file read, key read, and both unlinks refuse nlink and rethrow EPERM and EACCES', () => {
  const source = sourceText();
  const guard = sliceBetween(source, 'function refuseLinked', 'function object');
  const rethrowAt = guard.indexOf("code === 'EPERM' || code === 'EACCES'");
  const nlinkAt = guard.indexOf('stat.nlink > 1');
  assert.ok(rethrowAt >= 0 && nlinkAt > rethrowAt);
  assert.match(guard, /throw error/);
  assert.match(guard, /unsafe_path/);
  assert.equal(guard.includes('symlinkSync'), false);

  const fileBody = sliceBetween(source, 'file(scope:', 'mutateFile(scope:');
  assert.ok(fileBody.indexOf('refuseLinked(file)') >= 0);
  assert.ok(fileBody.indexOf('refuseLinked(file)') < fileBody.indexOf('fs.readFileSync(file)'));

  const mutate = sliceBetween(source, 'mutateFile(scope:', 'secret(input:');
  let from = 0;
  let unlinks = 0;
  while (from < mutate.length) {
    const at = mutate.indexOf('fs.unlinkSync(', from);
    if (at < 0) break;
    unlinks += 1;
    const prior = mutate.lastIndexOf('refuseLinked(', at);
    assert.ok(prior >= 0 && prior < at);
    from = at + 'fs.unlinkSync('.length;
  }
  assert.equal(unlinks, 2);

  const secretBody = sliceBetween(source, 'secret(input:', 'knowledge()');
  assert.ok(secretBody.indexOf('refuseLinked(keyFile)') >= 0);
  assert.ok(secretBody.indexOf('refuseLinked(keyFile)') < secretBody.indexOf('fs.readFileSync(keyFile)'));
  assert.match(secretBody, /flag: 'wx'/);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.toLowerCase().includes('junction'), false);
  assert.equal(/gradle|\.apk|assembleRelease|child_process/i.test(source), false);
});

test('a regular nlink 1 file still reads and the existing delete path still removes it', () => {
  withService('loam-49-local-nlink1-', (service, root) => {
    const id = upload(service, LOCAL);
    const stored = storedFile(root, id);
    assertPlain(stored);
    const loaded = service.file('shared', id);
    assert.equal(loaded.id, id);
    assert.deepEqual(loaded.bytes, LOCAL);
    assertPlain(stored);

    assert.deepEqual(service.mutateFile('shared', { action: 'delete', id }), { ok: true });
    assert.equal(fs.existsSync(stored), false);
    assert.equal(service.fileList().some((row) => row.id === id), false);
    assert.throws(
      () => service.file('shared', id),
      (error: unknown) => error instanceof MobileError && error.message === 'File not found',
    );
  });
});

test('a hard-linked stored file is refused before read and is not unlinked', () => {
  withService('loam-49-local-file-hard-', (service, root, outside) => {
    const id = upload(service, LOCAL);
    const stored = storedFile(root, id);
    const outsideFile = path.join(outside, 'note.bin');
    fs.writeFileSync(outsideFile, OUTSIDE);
    fs.unlinkSync(stored);
    fs.linkSync(outsideFile, stored);
    assertLinked(stored, outsideFile, OUTSIDE);

    const readCounts = watch(stored, () => {
      assert.throws(() => service.file('shared', id), refused);
    });
    assert.equal(readCounts.reads, 0);
    assert.equal(readCounts.unlinks, 0);
    assertLinked(stored, outsideFile, OUTSIDE);
    assert.equal(service.fileList().some((row) => row.id === id), true);

    const deleteCounts = watch(stored, () => {
      assert.throws(() => service.mutateFile('shared', { action: 'delete', id }), refused);
    });
    assert.equal(deleteCounts.reads, 0);
    assert.equal(deleteCounts.unlinks, 0);
    assertLinked(stored, outsideFile, OUTSIDE);
    assert.equal(service.fileList().some((row) => row.id === id), true);
  });
});

test('a hard-linked upload is not unlinked when the row cannot be saved', () => {
  withService('loam-49-local-unlink-hard-', (service, root, outside) => {
    service.db.exec("CREATE TRIGGER files_block BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
    const outsideFile = path.join(outside, 'kept.bin');
    const realWrite = fs.writeFileSync;
    let stored = '';
    let unlinks = 0;
    const realUnlink = fs.unlinkSync;
    fs.writeFileSync = ((target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      realWrite(target, data, options);
      if (typeof target === 'string' && samePath(path.dirname(target), path.join(root, '.loam', 'mobile-local', 'files'))) {
        stored = target;
        fs.linkSync(target, outsideFile);
      }
    }) as typeof fs.writeFileSync;
    fs.unlinkSync = ((target: fs.PathLike) => {
      if (stored && samePath(String(target), stored)) unlinks += 1;
      return realUnlink(target);
    }) as typeof fs.unlinkSync;
    try {
      assert.throws(
        () => service.mutateFile('shared', {
          action: 'upload',
          name: 'note.txt',
          type: 'text/plain',
          data: LOCAL.toString('base64'),
        }),
        refused,
      );
    } finally {
      fs.writeFileSync = realWrite;
      fs.unlinkSync = realUnlink;
    }
    assert.equal(unlinks, 0);
    assert.equal(stored.length > 0, true);
    assertLinked(stored, outsideFile, LOCAL);
    assert.equal(service.fileList().length, 0);
  });
});

test('a new key is still created with flag wx and a hard-linked key is refused before read', () => {
  withService('loam-49-local-key-wx-', (service, root) => {
    const file = keyFile(root);
    assert.equal(fs.existsSync(file), false);
    const realWrite = fs.writeFileSync;
    let flag = '';
    fs.writeFileSync = ((target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      if (typeof target === 'string' && samePath(target, file) && options && typeof options === 'object' && 'flag' in options)
        flag = String(options.flag);
      return realWrite(target, data, options);
    }) as typeof fs.writeFileSync;
    try {
      assert.deepEqual(service.secret({ action: 'set', name: 'APP_TOKEN', value: 'local-test-value' }), { ok: true });
    } finally {
      fs.writeFileSync = realWrite;
    }
    assert.equal(flag, 'wx');
    const created = fs.lstatSync(file);
    assert.equal(created.isSymbolicLink(), false);
    assert.equal(created.isFile(), true);
    assert.equal(created.nlink, 1);
    assert.equal(created.size, 32);
  });

  withService('loam-49-local-key-hard-', (service, root, outside) => {
    const file = keyFile(root);
    const outsideFile = path.join(outside, 'key-marker.bin');
    fs.writeFileSync(outsideFile, KEY_MARKER);
    fs.linkSync(outsideFile, file);
    assertLinked(file, outsideFile, KEY_MARKER);
    const counts = watch(file, () => {
      assert.throws(() => service.secret({ action: 'set', name: 'APP_TOKEN', value: 'local-test-value' }), refused);
    });
    assert.equal(counts.reads, 0);
    assert.equal(counts.writes, 0);
    assert.equal(counts.chmods, 0);
    assert.equal(counts.unlinks, 0);
    assertLinked(file, outsideFile, KEY_MARKER);
  });
});

test('lstat EPERM and EACCES are rethrown before the file read, the key read, and unlink', () => {
  for (const code of ['EPERM', 'EACCES'] as const) {
    withService(`loam-49-local-${code.toLowerCase()}-file-`, (service, root) => {
      const id = upload(service, LOCAL);
      const stored = storedFile(root, id);
      assertPlain(stored);
      const gate = gateLstat(stored, 2, code);
      try {
        const counts = watch(stored, () => {
          assert.throws(() => service.file('shared', id), isCode(code));
        });
        assert.equal(counts.reads, 0);
        assert.equal(counts.unlinks, 0);
        assert.equal(gate.seen() >= 2, true);
      } finally {
        gate.restore();
      }
      assertPlain(stored);
      assert.deepEqual(fs.readFileSync(stored), LOCAL);
    });

    withService(`loam-49-local-${code.toLowerCase()}-key-`, (service, root) => {
      const file = keyFile(root);
      assert.deepEqual(service.secret({ action: 'set', name: 'APP_TOKEN', value: 'local-test-value' }), { ok: true });
      const before = fs.lstatSync(file);
      assert.equal(before.nlink, 1);
      assert.equal(before.size, 32);
      const gate = gateLstat(file, 2, code);
      try {
        const counts = watch(file, () => {
          assert.throws(() => service.secret({ action: 'set', name: 'APP_TOKEN', value: 'local-test-value' }), isCode(code));
        });
        assert.equal(counts.reads, 0);
        assert.equal(counts.writes, 0);
        assert.equal(counts.chmods, 0);
        assert.equal(gate.seen() >= 2, true);
      } finally {
        gate.restore();
      }
      const after = fs.lstatSync(file);
      assert.equal(after.isSymbolicLink(), false);
      assert.equal(after.isFile(), true);
      assert.equal(after.nlink, 1);
      assert.equal(after.ino, before.ino);
      assert.equal(after.size, before.size);
    });

    withService(`loam-49-local-${code.toLowerCase()}-unlink-`, (service, root) => {
      const id = upload(service, LOCAL);
      const stored = storedFile(root, id);
      assertPlain(stored);
      const gate = gateLstat(stored, 4, code);
      try {
        const counts = watch(stored, () => {
          assert.throws(() => service.mutateFile('shared', { action: 'delete', id }), isCode(code));
        });
        assert.equal(counts.unlinks, 0);
        assert.equal(gate.seen() >= 4, true);
      } finally {
        gate.restore();
      }
      assertPlain(stored);
      assert.deepEqual(fs.readFileSync(stored), LOCAL);
      assert.equal(service.fileList().some((row) => row.id === id), true);
    });
  }
});
