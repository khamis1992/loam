/**
 * Template electron/main.cjs refuses a position, ready, probe, or error
 * destination whose nlink is greater than 1 before writeFileSync. Outside
 * bytes stay. A new position file still saves only {x,y} or {x,y,expanded:true}.
 * nodeIntegration stays false and contextIsolation stays true. This file does
 * not launch Electron, register a login item, or create a symlink or junction.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/templateMainHardLink.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../templates/electron-app/electron/main.cjs', import.meta.url), 'utf8');

type Writer = (file: string, text: string) => void;

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

function templateWriter(fileSystem: object): Writer {
  return vm.runInNewContext(`(${extractFunction('writeFileSync')})`, { fs: fileSystem, Error }) as Writer;
}

function positionExpressions(): string[] {
  const marker = 'writeFileSync(positionFile,';
  const expressions: string[] = [];
  let from = 0;
  while (from < source.length) {
    const at = source.indexOf(marker, from);
    if (at < 0) break;
    const end = source.indexOf(';', at);
    assert.equal(end >= 0, true);
    expressions.push(stringifyArgument(source.slice(at, end + 1)));
    from = end + 1;
  }
  return expressions;
}

function stringifyArgument(statement: string): string {
  const token = 'JSON.stringify(';
  const at = statement.indexOf(token);
  assert.equal(at >= 0, true, statement);
  const open = at + token.length - 1;
  let depth = 0;
  for (let index = open; index < statement.length; index += 1) {
    const char = statement[index];
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return statement.slice(open + 1, index);
    }
  }
  assert.fail(statement);
}

function savedRecord(expression: string, placed: Record<string, unknown>, frame: Record<string, unknown>): Record<string, unknown> {
  const storedPosition = vm.runInNewContext(`(${extractFunction('storedPosition')})`) as (
    placed: object,
    expanded: unknown,
  ) => Record<string, unknown>;
  const value: unknown = vm.runInNewContext(`(${expression})`, { storedPosition, placed, frame });
  assert.equal(value !== null && typeof value === 'object' && !Array.isArray(value), true);
  return value as Record<string, unknown>;
}

function writeDestinations(): string[] {
  const destinations: string[] = [];
  for (const match of source.matchAll(/(?<![\w.])writeFileSync\(/g)) {
    const index = match.index ?? 0;
    if (source.slice(Math.max(0, index - 9), index) === 'function ') continue;
    destinations.push(firstArgument(index + 'writeFileSync'.length));
  }
  return destinations;
}

function firstArgument(atParen: number): string {
  let depth = 1;
  const start = atParen + 1;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 1) return source.slice(start, index).trim();
  }
  assert.fail('destination');
}

function unsafePath(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function isEperm(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM';
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

test('template writes check nlink before writeFileSync and keep the window locked down', () => {
  const body = extractFunction('writeFileSync');
  const checkAt = body.indexOf('stat.nlink > 1');
  const writeAt = body.indexOf('fs.writeFileSync(');
  assert.equal(checkAt > 0, true);
  assert.equal(writeAt > checkAt, true);
  assert.match(body, /if \(!error \|\| error\.code !== 'ENOENT'\) throw error;/);
  assert.equal(body.includes('EPERM'), false);
  assert.equal(source.includes('EPERM'), false);
  assert.equal(source.includes('symlinkSync'), false);
  assert.equal(source.includes('junction'), false);
  assert.equal(source.includes('setLoginItemSettings'), false);
  assert.equal(source.match(/fs\.writeFileSync\(/g)?.length, 1);
  assert.deepEqual(writeDestinations(), [
    'positionFile',
    'positionFile',
    'readyFile',
    '`${readyFile}.error`',
    '`${readyFile}.probe`',
    '`${readyFile}.error`',
  ]);
  const blocks = [...source.matchAll(/webPreferences:\s*\{([^}]*)\}/g)];
  assert.equal(blocks.length, 1);
  const block = blocks[0]?.[1] ?? '';
  assert.match(block, /contextIsolation:\s*true/);
  assert.match(block, /nodeIntegration:\s*false/);
  assert.equal(/nodeIntegration:\s*true/.test(source), false);
  assert.equal(/contextIsolation:\s*false/.test(source), false);
  assert.equal(source.match(/nodeIntegration:/g)?.length, 1);
  assert.equal(source.match(/contextIsolation:/g)?.length, 1);
});

test('an existing position, ready, probe, or error file with nlink greater than 1 is refused before write', () => {
  const names = ['widget-window.json', 'ready', 'ready.probe', 'ready.error'];
  for (const name of names) {
    withPair('loam-46-main-', (app, outside) => {
      const destination = path.join(app, name);
      const outsideFile = path.join(outside, name);
      const previous = Buffer.from(`outside-${name}`);
      fs.writeFileSync(outsideFile, previous);
      fs.linkSync(outsideFile, destination);
      const stat = fs.lstatSync(destination);
      assert.equal(stat.isSymbolicLink(), false);
      assert.equal(stat.isFile(), true);
      assert.equal(stat.nlink > 1, true);
      assert.equal(stat.ino, fs.lstatSync(outsideFile).ino);
      let writes = 0;
      const writer = templateWriter({
        lstatSync: (file: string) => fs.lstatSync(file),
        writeFileSync: (file: string, text: string) => {
          writes += 1;
          fs.writeFileSync(file, text);
        },
      });
      assert.throws(() => writer(destination, 'changed\n'), unsafePath);
      assert.equal(writes, 0);
      assert.deepEqual(fs.readFileSync(destination), previous);
      assert.deepEqual(fs.readFileSync(outsideFile), previous);
      assert.equal(fs.lstatSync(destination).nlink > 1, true);
      assert.equal(fs.lstatSync(destination).isSymbolicLink(), false);
      assert.equal(fs.lstatSync(destination).ino, fs.lstatSync(outsideFile).ino);
      assert.deepEqual(fs.readdirSync(app), [name]);
    });
  }
});

test('a new position file still saves only x,y or x,y,expanded true', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-46-main-save-'));
  try {
    const writer = templateWriter(fs);
    const expressions = positionExpressions();
    assert.equal(expressions.length, 2);
    const extras = { width: 480, height: 360, note: 'local', next: 'https://example.test/a' };
    let index = 0;
    for (const expression of expressions) {
      assert.equal(expression.includes('storedPosition({ x: placed.x, y: placed.y }'), true, expression);
      for (const expanded of [false, true]) {
        const file = path.join(root, `position-${index}.json`);
        index += 1;
        assert.equal(fs.existsSync(file), false);
        const placed = { x: 12, y: 8, ...extras, expanded };
        const frame = { width: 320, height: 220, note: 'frame', expanded };
        const record = savedRecord(expression, placed, frame);
        writer(file, `${JSON.stringify(record)}\n`);
        const stat = fs.lstatSync(file);
        assert.equal(stat.isSymbolicLink(), false);
        assert.equal(stat.isFile(), true);
        assert.equal(stat.nlink, 1);
        const text = fs.readFileSync(file, 'utf8');
        assert.equal(text, expanded ? '{"x":12,"y":8,"expanded":true}\n' : '{"x":12,"y":8}\n');
        const stored = JSON.parse(text) as Record<string, unknown>;
        assert.deepEqual(Object.keys(stored), expanded ? ['x', 'y', 'expanded'] : ['x', 'y']);
        assert.equal(stored.x, 12);
        assert.equal(stored.y, 8);
        if (expanded) assert.equal(stored.expanded, true);
        else assert.equal(Object.hasOwn(stored, 'expanded'), false);
        for (const key of Object.keys(extras)) assert.equal(Object.hasOwn(stored, key), false, key);
      }
    }
    assert.deepEqual(fs.readdirSync(root).sort(), ['position-0.json', 'position-1.json', 'position-2.json', 'position-3.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a regular position file with nlink 1 still saves', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-46-main-nlink1-'));
  try {
    const file = path.join(root, 'widget-window.json');
    fs.writeFileSync(file, Buffer.from('previous-regular'));
    const before = fs.lstatSync(file);
    assert.equal(before.isFile(), true);
    assert.equal(before.isSymbolicLink(), false);
    assert.equal(before.nlink, 1);
    templateWriter(fs)(file, '{"x":3,"y":4,"expanded":true}\n');
    const stat = fs.lstatSync(file);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.nlink, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { x: 3, y: 4, expanded: true });
    assert.deepEqual(fs.readdirSync(root), ['widget-window.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lstat EPERM is not swallowed and the outside bytes stay', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-46-main-eperm-'));
  try {
    const file = path.join(root, 'widget-window.json');
    const previous = Buffer.from('{"x":1,"y":1}\n');
    fs.writeFileSync(file, previous);
    assert.equal(fs.lstatSync(file).nlink, 1);
    let writes = 0;
    const writer = templateWriter({
      lstatSync: () => {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      },
      writeFileSync: () => {
        writes += 1;
      },
    });
    assert.throws(() => writer(file, '{"x":9,"y":9}\n'), isEperm);
    assert.equal(writes, 0);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.nlink, 1);
    assert.deepEqual(fs.readFileSync(file), previous);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
