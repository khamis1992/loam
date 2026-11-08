/**
 * Template electron/main.cjs refuses nlink greater than 1 before the
 * desktop-app.json read, plainText's read and deletion, readPositionText,
 * the position read passed into readWidgetPosition, and the preview-input
 * read and deletion. Outside bytes stay untyped. EPERM and EACCES are
 * rethrown. A regular nlink 1 file still reads. This file does not launch
 * Electron, register a login item, or create a symlink or junction.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/templateMainReadHardLink.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../templates/electron-app/electron/main.cjs', import.meta.url), 'utf8');
const geometrySource = fs.readFileSync(new URL('../../templates/electron-app/electron/widget-geometry.cjs', import.meta.url), 'utf8');

type Counts = { reads: number; deletes: number };
type StatLike = { isFile: () => boolean; isSymbolicLink: () => boolean; nlink: number };
type PositionRecord = { x: number; y: number; expanded?: boolean } | null;
type ReadWidgetPosition = (lstat: () => StatLike, read: () => string) => PositionRecord;
type Readers = {
  readDesktopConfig: (file: string) => string | null;
  plainText: (file: string) => string | null;
  readPreviewInput: (file: string) => string | null;
  readPositionText: () => string;
  readPositionBytes: () => string;
  readPosition: () => PositionRecord;
};

const readWidgetPosition = loadReadWidgetPosition();

function extractFunction(name: string): string {
  const header = `function ${name}(`;
  const start = source.indexOf(header);
  assert.equal(start >= 0, true, name);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(name);
}

function loadReadWidgetPosition(): ReadWidgetPosition {
  const module = { exports: {} as { readWidgetPosition?: ReadWidgetPosition } };
  vm.runInNewContext(geometrySource, {
    module,
    exports: module.exports,
    require: (id: string) => {
      if (id === 'node:fs') return fs;
      throw new Error(id);
    },
    process,
  });
  assert.equal(typeof module.exports.readWidgetPosition, 'function');
  return module.exports.readWidgetPosition as ReadWidgetPosition;
}

function loadReaders(fileSystem: object, positionFile: string): Readers {
  const script = [
    extractFunction('refuseLinked'),
    extractFunction('readDesktopConfig'),
    extractFunction('plainText'),
    extractFunction('readPreviewInput'),
    extractFunction('readPositionText'),
    extractFunction('readPositionBytes'),
    extractFunction('readPosition'),
    '({ readDesktopConfig, plainText, readPreviewInput, readPositionText, readPositionBytes, readPosition })',
  ].join('\n');
  return vm.runInNewContext(script, {
    fs: fileSystem,
    positionFile,
    readWidgetPosition,
    Error,
  }) as Readers;
}

function countingFs(counts: Counts) {
  return {
    lstatSync: (file: fs.PathLike) => fs.lstatSync(file),
    readFileSync: (file: fs.PathLike, encoding?: BufferEncoding) => {
      counts.reads += 1;
      return fs.readFileSync(file, encoding);
    },
    rmSync: (file: fs.PathLike, options?: fs.RmOptions) => {
      counts.deletes += 1;
      fs.rmSync(file, options);
    },
  };
}

function deniedFs(code: 'EPERM' | 'EACCES', counts: Counts) {
  return {
    lstatSync: () => {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = code;
      throw error;
    },
    readFileSync: () => {
      counts.reads += 1;
      return 'outside-secret';
    },
    rmSync: () => {
      counts.deletes += 1;
    },
  };
}

function unsafePath(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isCode(code: 'EPERM' | 'EACCES'): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function before(body: string, left: string, right: string): void {
  const leftAt = body.indexOf(left);
  const rightAt = body.indexOf(right);
  assert.equal(leftAt >= 0, true, left);
  assert.equal(rightAt > leftAt, true, `${left} before ${right}`);
}

function withPair(prefix: string, run: (app: string, outside: string) => void): void {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}out-`));
  try {
    run(app, outside);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

function withLink(name: string, bytes: Buffer, run: (linked: string, outsideFile: string) => void): void {
  withPair('loam-49-main-read-', (app, outside) => {
    const outsideFile = path.join(outside, name);
    const linked = path.join(app, name);
    fs.writeFileSync(outsideFile, bytes);
    fs.linkSync(outsideFile, linked);
    const stat = fs.lstatSync(linked);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
    assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
    run(linked, outsideFile);
    assert.deepEqual(fs.readFileSync(linked), bytes);
    assert.deepEqual(fs.readFileSync(outsideFile), bytes);
    const after = fs.lstatSync(linked);
    assert.equal(after.isSymbolicLink(), false);
    assert.equal(after.isFile(), true);
    assert.equal(after.nlink > 1, true);
    assert.equal(after.ino, fs.lstatSync(outsideFile).ino);
    assert.deepEqual(fs.readdirSync(app), [name]);
  });
}

test('template reads refuse a shared link before readFileSync and the write check stays', () => {
  const guard = extractFunction('refuseLinked');
  before(guard, 'fs.lstatSync(file)', 'stat.nlink > 1');
  assert.match(guard, /if \(!error \|\| error\.code !== 'ENOENT'\) throw error;/);
  assert.match(guard, /if \(stat\.nlink > 1\) throw new Error\('unsafe_path'\)/);
  for (const name of ['readDesktopConfig', 'plainText', 'readPreviewInput', 'readPositionText']) {
    const body = extractFunction(name);
    before(body, 'refuseLinked(', 'fs.readFileSync(');
    assert.equal(body.includes('catch'), false, name);
  }
  for (const name of ['plainText', 'readPreviewInput']) {
    const body = extractFunction(name);
    before(body, 'refuseLinked(', 'fs.rmSync(');
    before(body, 'fs.readFileSync(', 'fs.rmSync(');
  }
  const bytes = extractFunction('readPositionBytes');
  before(bytes, 'stat.nlink > 1', 'fs.readFileSync(');
  assert.equal(bytes.includes('catch'), false);
  const position = extractFunction('readPosition');
  before(position, 'refuseLinked(positionFile)', 'readWidgetPosition(');
  before(position, 'return readPositionBytes()', 'if (failure) throw failure');
  assert.match(position, /catch \(error\) \{\s*failure = error;\s*throw error;\s*\}/);
  const writer = extractFunction('writeFileSync');
  before(writer, 'stat.nlink > 1', 'fs.writeFileSync(');
  assert.match(writer, /if \(!error \|\| error\.code !== 'ENOENT'\) throw error;/);
  assert.equal(source.match(/fs\.readFileSync\(/g)?.length, 5);
  assert.equal(source.match(/fs\.rmSync\(/g)?.length, 2);
  assert.equal(source.match(/fs\.writeFileSync\(/g)?.length, 1);
  assert.equal(source.match(/stat\.nlink > 1/g)?.length, 3);
  assert.equal(source.includes('setLoginItemSettings'), false);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('junction'), false);
  assert.equal(source.includes('EPERM'), false);
  assert.equal(source.includes('EACCES'), false);
  assert.match(source, /scenario: 'file-organizer', title: 'Loam File Organizer', version: 1/);
  assert.match(source, /const typed = readPreviewInput\(path\.join\(__dirname, '\.\.', 'preview-input\.txt'\)\);/);
  assert.match(source, /const typed = \$\{JSON\.stringify\(typed\)\};/);
  const blocks = [...source.matchAll(/webPreferences:\s*\{([^}]*)\}/g)];
  assert.equal(blocks.length, 1);
  const block = blocks[0]?.[1] ?? '';
  assert.match(block, /contextIsolation:\s*true/);
  assert.match(block, /nodeIntegration:\s*false/);
  assert.equal(/nodeIntegration:\s*true/.test(source), false);
  assert.equal(/contextIsolation:\s*false/.test(source), false);
});

test('a hard-linked config, preview, or position file is refused before read or delete', () => {
  const outsideBytes = Buffer.from('{"x":9,"y":8,"secret":"outside-secret"}\n');
  const cases: Array<{ name: string; call: (readers: Readers, file: string) => unknown }> = [
    { name: 'desktop-app.json', call: (readers, file) => readers.readDesktopConfig(file) },
    { name: 'preview-move.txt', call: (readers, file) => readers.plainText(file) },
    { name: 'preview-input.txt', call: (readers, file) => readers.readPreviewInput(file) },
    { name: 'widget-text.json', call: (readers) => readers.readPositionText() },
    { name: 'widget-bytes.json', call: (readers) => readers.readPositionBytes() },
    { name: 'widget-record.json', call: (readers) => readers.readPosition() },
  ];
  for (const item of cases) {
    withLink(item.name, outsideBytes, (linked) => {
      const counts: Counts = { reads: 0, deletes: 0 };
      const readers = loadReaders(countingFs(counts), linked);
      assert.throws(() => item.call(readers, linked), unsafePath);
      assert.equal(counts.reads, 0, item.name);
      assert.equal(counts.deletes, 0, item.name);
    });
  }
});

test('the position read passed into readWidgetPosition still throws after that helper swallows it', () => {
  for (const code of ['EPERM', 'EACCES'] as const) {
    let seen = 0;
    const counts: Counts = { reads: 0, deletes: 0 };
    const readers = loadReaders({
      lstatSync: () => {
        seen += 1;
        if (seen > 1) {
          const error = new Error('operation not permitted') as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        }
        return { isFile: () => true, isSymbolicLink: () => false, nlink: 1 };
      },
      readFileSync: () => {
        counts.reads += 1;
        return '{"x":9,"y":8,"secret":"outside-secret"}\n';
      },
      rmSync: () => {
        counts.deletes += 1;
      },
    }, 'widget-window.json');
    assert.throws(() => readers.readPosition(), isCode(code));
    assert.equal(counts.reads, 0, code);
    assert.equal(counts.deletes, 0, code);
    assert.equal(seen > 1, true, code);
  }
  let seen = 0;
  const counts: Counts = { reads: 0, deletes: 0 };
  const readers = loadReaders({
    lstatSync: () => {
      seen += 1;
      return { isFile: () => true, isSymbolicLink: () => false, nlink: seen === 1 ? 1 : 3 };
    },
    readFileSync: () => {
      counts.reads += 1;
      return '{"x":9,"y":8,"secret":"outside-secret"}\n';
    },
    rmSync: () => {
      counts.deletes += 1;
    },
  }, 'widget-window.json');
  assert.throws(() => readers.readPosition(), unsafePath);
  assert.equal(counts.reads, 0);
  assert.equal(counts.deletes, 0);
  assert.equal(seen > 1, true);
});

test('lstat EPERM and EACCES are rethrown and the file is not read or deleted', () => {
  for (const code of ['EPERM', 'EACCES'] as const) {
    const counts: Counts = { reads: 0, deletes: 0 };
    const readers = loadReaders(deniedFs(code, counts), 'widget-window.json');
    assert.throws(() => readers.readDesktopConfig('desktop-app.json'), isCode(code));
    assert.throws(() => readers.plainText('preview-move.txt'), isCode(code));
    assert.throws(() => readers.readPreviewInput('preview-input.txt'), isCode(code));
    assert.throws(() => readers.readPositionText(), isCode(code));
    assert.throws(() => readers.readPositionBytes(), isCode(code));
    assert.throws(() => readers.readPosition(), isCode(code));
    assert.equal(counts.reads, 0, code);
    assert.equal(counts.deletes, 0, code);
  }
});

test('a missing file still falls back without reading', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-49-main-read-missing-'));
  try {
    const counts: Counts = { reads: 0, deletes: 0 };
    const missing = path.join(root, 'missing.json');
    const readers = loadReaders(countingFs(counts), missing);
    assert.equal(fs.existsSync(missing), false);
    assert.equal(readers.readDesktopConfig(missing), null);
    assert.equal(readers.plainText(missing), null);
    assert.equal(readers.readPreviewInput(missing), null);
    assert.equal(readers.readPositionText(), '');
    assert.equal(readers.readPosition(), null);
    assert.equal(counts.reads, 0);
    assert.equal(counts.deletes, 0);
    assert.equal(fs.existsSync(missing), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a regular nlink 1 file still reads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-49-main-read-nlink1-'));
  try {
    const counts: Counts = { reads: 0, deletes: 0 };
    const config = path.join(root, 'desktop-app.json');
    const move = path.join(root, 'preview-move.txt');
    const input = path.join(root, 'preview-input.txt');
    const position = path.join(root, 'widget-window.json');
    fs.writeFileSync(config, '{"title":"Loam"}\n');
    fs.writeFileSync(move, 'move-ok\n');
    fs.writeFileSync(input, 'typed\r\n');
    fs.writeFileSync(position, '{"x":6,"y":7,"expanded":true}\n');
    for (const file of [config, move, input, position]) {
      const stat = fs.lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false);
      assert.equal(stat.isFile(), true);
      assert.equal(stat.nlink, 1);
    }
    const readers = loadReaders(countingFs(counts), position);
    assert.equal(readers.readDesktopConfig(config), '{"title":"Loam"}\n');
    assert.equal(readers.plainText(move), 'move-ok\n');
    assert.equal(fs.existsSync(move), false);
    assert.equal(readers.readPreviewInput(input), 'typed');
    assert.equal(fs.existsSync(input), false);
    fs.writeFileSync(input, `${'b'.repeat(240)}\n`);
    assert.equal(fs.lstatSync(input).nlink, 1);
    assert.equal(readers.readPreviewInput(input), 'b'.repeat(200));
    assert.equal(readers.readPositionText(), '{"x":6,"y":7,"expanded":true}\n');
    assert.deepEqual(JSON.parse(JSON.stringify(readers.readPosition())), { x: 6, y: 7, expanded: true });
    fs.writeFileSync(position, '{"x":1,"y":2}\n');
    assert.equal(readers.readPositionBytes(), '{"x":1,"y":2}\n');
    assert.deepEqual(JSON.parse(JSON.stringify(readers.readPosition())), { x: 1, y: 2 });
    const stat = fs.lstatSync(position);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.nlink, 1);
    assert.equal(counts.reads, 8);
    assert.equal(counts.deletes, 3);
    assert.deepEqual(fs.readdirSync(root).sort(), ['desktop-app.json', 'widget-window.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
