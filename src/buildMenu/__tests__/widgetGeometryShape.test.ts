import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeWidgetPosition } from '../widget/geometry.js';

function withApp(run: (app: string) => void): void {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-43-widget-app-'));
  try {
    run(app);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
}

function invalidRequest(error: unknown): boolean {
  return error instanceof Error && error.message === 'invalid_request';
}

function unsafePath(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function positionFile(app: string): string {
  return path.join(app, 'widget-window.json');
}

test('saved widget position accepts only x,y or x,y,expanded true', () => {
  withApp((app) => {
    const file = positionFile(app);
    assert.equal(fs.existsSync(file), false);
    assert.throws(() => writeWidgetPosition(app, file, JSON.stringify({ x: 1, y: 2, note: 'local' })), invalidRequest);
    assert.equal(fs.existsSync(file), false);

    writeWidgetPosition(app, file, ' { "y" : 8, "x" : 12 } ');
    const compact = Buffer.from(`${JSON.stringify({ x: 12, y: 8 })}\n`);
    assert.deepEqual(fs.readFileSync(file), compact);
    const compactStat = fs.lstatSync(file);
    assert.equal(compactStat.isFile(), true);
    assert.equal(compactStat.isSymbolicLink(), false);

    writeWidgetPosition(app, 'widget-window.json', JSON.stringify({ x: 3, y: 4, expanded: true }));
    const expanded = Buffer.from(`${JSON.stringify({ x: 3, y: 4, expanded: true })}\n`);
    assert.deepEqual(fs.readFileSync(file), expanded);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(saved).sort(), ['expanded', 'x', 'y']);
    assert.equal(saved.expanded, true);

    const extras = [
      JSON.stringify({ x: 1, y: 2, note: 'local' }),
      JSON.stringify({ x: 1, y: 2, expanded: true, note: 'local' }),
      JSON.stringify({ x: 1, y: 2, expanded: false }),
      JSON.stringify({ x: 1, y: 2, expanded: 'yes' }),
      JSON.stringify({ x: 1 }),
      '{"x":1e309,"y":1}',
    ];
    for (const text of extras) {
      assert.throws(() => writeWidgetPosition(app, file, text), invalidRequest, text);
      assert.deepEqual(fs.readFileSync(file), expanded, text);
    }

    const remotes = [
      JSON.stringify({ x: 1, y: 2, next: 'https://example.test/a' }),
      JSON.stringify({ x: 1, y: 2, next: 'http://example.test/a' }),
      JSON.stringify({ x: 'javascript:alert(1)', y: 2 }),
      JSON.stringify({ x: 1, y: 2, expanded: true, url: 'data:text/html,hi' }),
      JSON.stringify({ x: 1, y: 'file:///C:/secret.txt' }),
      JSON.stringify({ x: 1, y: 2, next: 'mailto:user@example.test' }),
      JSON.stringify({ x: 1, y: 2, next: '//example.test/a' }),
      JSON.stringify({ x: 1, y: 2, next: 'https%3A%2F%2Fexample.test/a' }),
      JSON.stringify({ x: 1, y: 2, next: 'https%253A%252F%252Fexample.test/a' }),
      '{"x":1,"y":2,"next":"https"+"://example.test/a"}',
      '{"x":"\\u0068\\u0074\\u0074\\u0070\\u0073://example.test/a","y":2}',
    ];
    for (const text of remotes) {
      assert.throws(() => writeWidgetPosition(app, file, text), unsafePath, text);
      assert.deepEqual(fs.readFileSync(file), expanded, text);
    }
  });
});

test('a widget position path outside the app is rejected and leaves previous bytes', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-43-widget-app-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-43-widget-out-'));
  try {
    const file = positionFile(app);
    writeWidgetPosition(app, 'widget-window.json', JSON.stringify({ x: 12, y: 8 }));
    const inside = fs.readFileSync(file);
    const outsideFile = path.join(outside, 'widget-window.json');
    const previous = Buffer.from('previous-outside-bytes');
    fs.writeFileSync(outsideFile, previous);
    assert.equal(path.isAbsolute(outsideFile), true);
    assert.equal(path.relative(app, path.resolve(outsideFile)).startsWith('..'), true);

    assert.throws(() => writeWidgetPosition(app, outsideFile, JSON.stringify({ x: 1, y: 2 })), unsafePath);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(fs.readFileSync(file), inside);

    const relativeEscape = path.join('..', path.basename(outside), 'widget-window.json');
    assert.equal(path.resolve(app, relativeEscape), path.resolve(outsideFile));
    assert.throws(() => writeWidgetPosition(app, relativeEscape, JSON.stringify({ x: 9, y: 9, expanded: true })), unsafePath);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(fs.readFileSync(file), inside);

    const missing = path.join(outside, 'missing-widget-window.json');
    assert.equal(fs.existsSync(missing), false);
    assert.throws(() => writeWidgetPosition(app, missing, JSON.stringify({ x: 1, y: 2 })), unsafePath);
    assert.equal(fs.existsSync(missing), false);
    assert.deepEqual(fs.readFileSync(outsideFile), previous);
    assert.deepEqual(fs.readFileSync(file), inside);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
