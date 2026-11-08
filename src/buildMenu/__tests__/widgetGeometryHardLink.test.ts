import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeWidgetPosition } from '../widget/geometry.js';

function unsafePath(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

test('an existing position file with nlink greater than 1 is refused before write', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-widget-app-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-widget-out-'));
  try {
    const file = path.join(app, 'widget-window.json');
    const linked = path.join(outside, 'outside-bytes.txt');
    const previous = Buffer.from('previous-outside-bytes');
    fs.writeFileSync(linked, previous);
    fs.linkSync(linked, file);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);

    assert.throws(() => writeWidgetPosition(app, 'widget-window.json', JSON.stringify({ x: 1, y: 2 })), unsafePath);
    assert.deepEqual(fs.readFileSync(linked), previous);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.equal(fs.lstatSync(file).nlink > 1, true);

    assert.throws(
      () => writeWidgetPosition(app, 'widget-window.json', JSON.stringify({ x: 3, y: 4, expanded: true })),
      unsafePath,
    );
    assert.deepEqual(fs.readFileSync(linked), previous);
    assert.deepEqual(fs.readFileSync(file), previous);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(linked).nlink > 1, true);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a regular position file still saves x,y and x,y,expanded true', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-45-widget-regular-'));
  try {
    const file = path.join(app, 'widget-window.json');
    fs.writeFileSync(file, Buffer.from('regular-before'));
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(file).isFile(), true);
    assert.equal(fs.lstatSync(file).nlink, 1);

    writeWidgetPosition(app, 'widget-window.json', JSON.stringify({ x: 12, y: 8 }));
    const compact = Buffer.from(`${JSON.stringify({ x: 12, y: 8 })}\n`);
    assert.deepEqual(fs.readFileSync(file), compact);
    const compactStat = fs.lstatSync(file);
    assert.equal(compactStat.isFile(), true);
    assert.equal(compactStat.isSymbolicLink(), false);
    assert.equal(compactStat.nlink, 1);

    writeWidgetPosition(app, 'widget-window.json', JSON.stringify({ x: 3, y: 4, expanded: true }));
    const expanded = Buffer.from(`${JSON.stringify({ x: 3, y: 4, expanded: true })}\n`);
    assert.deepEqual(fs.readFileSync(file), expanded);
    const opened = fs.lstatSync(file);
    assert.equal(opened.isFile(), true);
    assert.equal(opened.isSymbolicLink(), false);
    assert.equal(opened.nlink, 1);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});
