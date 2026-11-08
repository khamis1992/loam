import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { placedWidget } from '../widget/geometry.js';

const require = createRequire(import.meta.url);
const template = require('../../templates/electron-app/electron/widget-geometry.cjs') as {
  placedWidget: typeof placedWidget;
  readWidgetPosition: (lstat: () => { isFile: () => boolean; isSymbolicLink: () => boolean }, read: () => string) => { x: number; y: number; expanded?: boolean } | null;
};

const area = { x: 0, y: 0, width: 1280, height: 720 };

test('a damaged widget position returns to the display and an off-screen point is clamped', () => {
  const damaged = placedWidget('{', area);
  assert.deepEqual(damaged, { x: 0, y: 0, width: 320, height: 220, expanded: false });
  assert.deepEqual(template.placedWidget('{', area), damaged);
  const away = placedWidget(JSON.stringify({ x: 4000, y: -500 }), area);
  assert.deepEqual(away, { x: 960, y: 0, width: 320, height: 220, expanded: false });
  assert.deepEqual(template.placedWidget(JSON.stringify({ x: 4000, y: -500 }), area), away);
  const expanded = placedWidget(JSON.stringify({ x: 10, y: 10, expanded: true }), area);
  assert.deepEqual(expanded, { x: 10, y: 10, width: 480, height: 360, expanded: true });
  assert.deepEqual(template.placedWidget(JSON.stringify({ x: 10, y: 10, expanded: true }), area), expanded);
  let reads = 0;
  const link = { isFile: () => true, isSymbolicLink: () => true };
  assert.equal(template.readWidgetPosition(() => link, () => { reads += 1; return '{"x":1,"y":2}'; }), null);
  assert.equal(reads, 0);
  const file = { isFile: () => true, isSymbolicLink: () => false };
  assert.deepEqual(template.readWidgetPosition(() => file, () => '{"x":12,"y":8,"expanded":true}'), { x: 12, y: 8, expanded: true });
});
