import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  MOVE_DEBOUNCE_MS,
  createWidgetMoveSaver,
  defaultWidgetGeometry,
  resolveWidgetGeometry,
  type DisplayBounds,
  type DisplayBox,
  type WidgetGeometry,
} from '../widget/geometry.js';

const require = createRequire(import.meta.url);
const templateGeometry = require(path.resolve('src/templates/electron-app/electron/widget-geometry.cjs')) as {
  placedWidgetOnDisplays(text: string, displays: readonly DisplayBounds[]): WidgetGeometry;
};

function display(id: string, bounds: DisplayBox, workArea: DisplayBox): DisplayBounds {
  return { id, bounds, workArea };
}

function insideWorkArea(placed: WidgetGeometry, area: DisplayBox): boolean {
  return placed.x >= area.x
    && placed.y >= area.y
    && placed.x + placed.width <= area.x + area.width
    && placed.y + placed.height <= area.y + area.height;
}

const laptop = display(
  'laptop',
  { x: 0, y: 0, width: 1920, height: 1080 },
  { x: 0, y: 48, width: 1920, height: 1032 },
);

const hdmi = display(
  'hdmi',
  { x: 1920, y: 0, width: 1920, height: 1080 },
  { x: 1920, y: 0, width: 1920, height: 1080 },
);

test('first position stays inside a display work area', () => {
  const first = defaultWidgetGeometry([laptop]);
  assert.deepEqual(first, {
    x: 0,
    y: 48,
    width: 320,
    height: 220,
    expanded: false,
    displayId: 'laptop',
  });
  assert.equal(insideWorkArea(first, laptop.workArea), true);

  const left = display(
    'left',
    { x: -1920, y: 0, width: 1920, height: 1080 },
    { x: -1920, y: 20, width: 1920, height: 1060 },
  );
  const opened = defaultWidgetGeometry([left]);
  assert.deepEqual(opened, {
    x: -1920,
    y: 20,
    width: 320,
    height: 220,
    expanded: false,
    displayId: 'left',
  });
  assert.equal(insideWorkArea(opened, left.workArea), true);
});

test('corrupt saved JSON falls back to the default', () => {
  const expected = defaultWidgetGeometry([laptop]);
  const damaged = ['{', '', '   ', 'null', '[]', '{"x":1}', '{"x":null,"y":4}', 'not json'];
  for (const text of damaged) {
    assert.deepEqual(resolveWidgetGeometry(text, [laptop]), expected);
  }
  assert.equal(insideWorkArea(expected, laptop.workArea), true);
});

test('a disconnected monitor is clamped back inside', () => {
  const saved = JSON.stringify({ x: 2100, y: 120 });
  const connected = resolveWidgetGeometry(saved, [laptop, hdmi]);
  assert.deepEqual(connected, {
    x: 2100,
    y: 120,
    width: 320,
    height: 220,
    expanded: false,
    displayId: 'hdmi',
  });
  assert.equal(insideWorkArea(connected, hdmi.workArea), true);

  const clamped = resolveWidgetGeometry(saved, [laptop]);
  assert.deepEqual(clamped, {
    x: 1600,
    y: 120,
    width: 320,
    height: 220,
    expanded: false,
    displayId: 'laptop',
  });
  assert.equal(insideWorkArea(clamped, laptop.workArea), true);

  const expanded = resolveWidgetGeometry(JSON.stringify({ x: 2100, y: 120, expanded: true }), [laptop]);
  assert.deepEqual(expanded, {
    x: 1440,
    y: 120,
    width: 480,
    height: 360,
    expanded: true,
    displayId: 'laptop',
  });
  assert.equal(insideWorkArea(expanded, laptop.workArea), true);
});

test('a move is saved with a 250ms debounce', () => {
  assert.equal(MOVE_DEBOUNCE_MS, 250);
  mock.timers.enable({ apis: ['setTimeout'] });
  const writes: string[] = [];
  let connected = [laptop, hdmi];
  const saver = createWidgetMoveSaver({
    displays: () => connected,
    write: (text) => {
      writes.push(text);
    },
  });
  try {
    saver.move({ x: 200, y: 80 });
    assert.deepEqual(writes, []);
    mock.timers.tick(249);
    assert.deepEqual(writes, []);

    saver.move({ x: 2100, y: 120 });
    mock.timers.tick(249);
    assert.deepEqual(writes, []);
    connected = [laptop];
    mock.timers.tick(1);
    assert.deepEqual(writes, [`${JSON.stringify({ x: 1600, y: 120 })}\n`]);

    saver.move({ x: 2100, y: 120, expanded: true });
    mock.timers.tick(249);
    assert.equal(writes.length, 1);
    mock.timers.tick(1);
    assert.deepEqual(writes, [
      `${JSON.stringify({ x: 1600, y: 120 })}\n`,
      `${JSON.stringify({ x: 1440, y: 120, expanded: true })}\n`,
    ]);
    mock.timers.tick(1000);
    assert.equal(writes.length, 2);
  } finally {
    saver.cancel();
    mock.timers.reset();
  }
});

test('the packaged widget geometry matches the build-menu placement', () => {
  const cases = [
    '',
    'not json',
    JSON.stringify({ x: 2100, y: 120 }),
    JSON.stringify({ x: 2100, y: 120, expanded: true }),
  ];
  const lists = [[laptop], [laptop, hdmi], [hdmi]];
  for (const text of cases) {
    for (const displays of lists) {
      const expected = resolveWidgetGeometry(text, displays);
      const packaged = templateGeometry.placedWidgetOnDisplays(text, displays);
      assert.deepEqual(packaged, expected);
    }
  }
});
