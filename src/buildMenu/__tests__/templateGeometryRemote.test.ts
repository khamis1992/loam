import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const template = require('../../templates/electron-app/electron/widget-geometry.cjs') as {
  placedWidget: (
    text: string,
    area: { x: number; y: number; width: number; height: number },
  ) => { x: number; y: number; width: number; height: number; expanded: boolean };
  placedWidgetOnDisplays: (
    text: string,
    displays: readonly {
      id: string;
      bounds: { x: number; y: number; width: number; height: number };
      workArea: { x: number; y: number; width: number; height: number };
    }[],
  ) => { x: number; y: number; width: number; height: number; expanded: boolean; displayId: string };
  readWidgetPosition: (
    lstat: () => { isFile: () => boolean; isSymbolicLink: () => boolean },
    read: () => string,
  ) => { x: number; y: number; expanded?: boolean } | null;
};

const area = { x: 0, y: 0, width: 1280, height: 720 };
const laptop = {
  id: 'laptop',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 48, width: 1920, height: 1032 },
};
const file = { isFile: () => true, isSymbolicLink: () => false };
const parked = { x: 0, y: 0, width: 320, height: 220, expanded: false };
const parkedDisplay = { x: 0, y: 48, width: 320, height: 220, expanded: false, displayId: 'laptop' };

function assertUnused(text: string): void {
  assert.deepEqual(template.placedWidget(text, area), parked, text);
  assert.deepEqual(template.placedWidgetOnDisplays(text, [laptop]), parkedDisplay, text);
  assert.equal(template.readWidgetPosition(() => file, () => text), null, text);
}

test('a remote scheme coordinate or raw scheme text is not used', () => {
  const schemes = [
    'https://evil.example/a',
    'http://evil.example/a',
    'javascript:alert(1)',
    'data:text/html,hi',
    'file:///C:/secret.txt',
    'blob:null/uuid',
    'mailto:user@example.test',
    'tel:+97455500000',
    'sms:+97455500000',
    'intent:#Intent;end',
    'market://details',
    '//evil.example/a',
  ];
  for (const scheme of schemes) {
    assertUnused(JSON.stringify({ x: scheme, y: 400 }));
    assertUnused(JSON.stringify({ x: 500, y: scheme }));
  }
  assertUnused('{"x":"\\u0068\\u0074\\u0074\\u0070\\u0073://example.test/a","y":2}');

  const words = ['mailto', 'tel', 'sms', 'intent', 'market', 'https', 'javascript'] as const;
  for (const word of words) {
    assertUnused(JSON.stringify({ x: 400, y: 500, next: `${word}:payload` }));
    assertUnused(JSON.stringify({ x: 400, y: 500, next: word.toUpperCase() }));
    assertUnused(`{"x":400,"y":500} ${word}`);
  }
  assertUnused('{"x":1,"y":2,"next":"https"+"://example.test/a"}');
});

test('extra keys are omitted from the stored widget point', () => {
  const compact = JSON.stringify({ x: 12, y: 8, note: 'local', zoom: 1 });
  const stored = template.readWidgetPosition(() => file, () => compact);
  assert.deepEqual(stored, { x: 12, y: 8 });
  assert.deepEqual(Object.keys(stored ?? {}).sort(), ['x', 'y']);

  const openedText = JSON.stringify({ x: 3, y: 80, expanded: true, note: 'desk' });
  const opened = template.readWidgetPosition(() => file, () => openedText);
  assert.deepEqual(opened, { x: 3, y: 80, expanded: true });
  assert.deepEqual(Object.keys(opened ?? {}).sort(), ['expanded', 'x', 'y']);

  const placed = template.placedWidget(compact, area);
  assert.deepEqual(placed, { x: 12, y: 8, width: 320, height: 220, expanded: false });
  assert.equal(Object.hasOwn(placed, 'note'), false);

  const onDisplay = template.placedWidgetOnDisplays(openedText, [laptop]);
  assert.deepEqual(onDisplay, {
    x: 3,
    y: 80,
    width: 480,
    height: 360,
    expanded: true,
    displayId: 'laptop',
  });
  assert.equal(Object.hasOwn(onDisplay, 'note'), false);
});
