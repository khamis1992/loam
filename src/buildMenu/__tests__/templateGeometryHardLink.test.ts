import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const template = require('../../templates/electron-app/electron/widget-geometry.cjs') as {
  saveWidgetPosition: (file: string, text: string) => void;
};

function unsafePath(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

test('an existing position file with nlink greater than 1 is refused before write or rename', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-geometry-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-geometry-out-'));
  try {
    const file = path.join(app, 'widget-window.json');
    const linked = path.join(outside, 'secret.json');
    const previous = Buffer.from('outside-bytes');
    fs.writeFileSync(linked, previous);
    fs.linkSync(linked, file);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);

    assert.throws(() => template.saveWidgetPosition(file, JSON.stringify({ x: 9, y: 9 })), unsafePath);

    assert.deepEqual(fs.readFileSync(file), previous);
    assert.deepEqual(fs.readFileSync(linked), previous);
    assert.deepEqual(fs.readdirSync(app), ['widget-window.json']);
    assert.equal(fs.lstatSync(file).nlink > 1, true);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a normal x,y save on a regular file keeps extra keys off the stored point', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-geometry-save-'));
  try {
    const file = path.join(app, 'widget-window.json');
    fs.writeFileSync(file, Buffer.from('previous-regular'));
    const before = fs.lstatSync(file);
    assert.equal(before.isFile(), true);
    assert.equal(before.isSymbolicLink(), false);
    assert.equal(before.nlink, 1);

    template.saveWidgetPosition(file, JSON.stringify({ x: 12, y: 8, note: 'local', zoom: 1 }));

    const stat = fs.lstatSync(file);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.nlink, 1);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(stored, { x: 12, y: 8 });
    assert.deepEqual(Object.keys(stored).sort(), ['x', 'y']);
    assert.deepEqual(fs.readdirSync(app), ['widget-window.json']);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});
