const fs = require('node:fs');

const WIDGET_WIDTH = 320;
const WIDGET_HEIGHT = 220;
const WIDGET_EXPANDED_WIDTH = 480;
const WIDGET_EXPANDED_HEIGHT = 360;
const MOVE_DEBOUNCE_MS = 250;
const REMOTE_POSITION_TEXT = /mailto|tel|sms|intent|market|https|javascript/i;

function remotePositionText(text) {
  return typeof text === 'string' && REMOTE_POSITION_TEXT.test(text);
}

function widgetFrame(expanded) {
  if (expanded === true) return { width: WIDGET_EXPANDED_WIDTH, height: WIDGET_EXPANDED_HEIGHT, expanded: true };
  return { width: WIDGET_WIDTH, height: WIDGET_HEIGHT, expanded: false };
}

function clampPosition(point, area, size) {
  const width = size && Number.isFinite(size.width) ? size.width : WIDGET_WIDTH;
  const height = size && Number.isFinite(size.height) ? size.height : WIDGET_HEIGHT;
  const x = Number.isFinite(point.x) ? point.x : area.x;
  const y = Number.isFinite(point.y) ? point.y : area.y;
  return {
    x: Math.min(Math.max(x, area.x), Math.max(area.x, area.x + area.width - width)),
    y: Math.min(Math.max(y, area.y), Math.max(area.y, area.y + area.height - height)),
  };
}

function storedPlacement(text, area) {
  const fallback = { x: area.x, y: area.y, expanded: false };
  if (remotePositionText(text)) return fallback;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return fallback;
    return { x: parsed.x, y: parsed.y, expanded: parsed.expanded === true };
  } catch {
    return fallback;
  }
}

function regularPositionFile(stat) {
  return Boolean(stat && typeof stat.isFile === 'function' && stat.isFile() && !stat.isSymbolicLink());
}

function positionRecord(text) {
  if (remotePositionText(text)) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
    const point = { x: parsed.x, y: parsed.y };
    return parsed.expanded === true ? { ...point, expanded: true } : point;
  } catch {
    return null;
  }
}

function readWidgetPosition(lstat, read) {
  try {
    if (!regularPositionFile(lstat())) return null;
    return positionRecord(read());
  } catch {
    return null;
  }
}

function errorCode(error) {
  if (!error || typeof error !== 'object' || typeof error.code !== 'string') return '';
  return error.code;
}

function positionStat(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function assertReplaceablePosition(file) {
  const stat = positionStat(file);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
}

function removeTemporary(temporary) {
  try {
    fs.rmSync(temporary, { force: true });
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

function saveWidgetPosition(file, text) {
  if (typeof file !== 'string' || file.length === 0) throw new Error('unsafe_path');
  const record = positionRecord(text);
  if (!record) throw new Error('invalid_request');
  assertReplaceablePosition(file);
  const temporary = `${file}.${process.pid}.tmp`;
  assertReplaceablePosition(temporary);
  fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    assertReplaceablePosition(file);
    fs.renameSync(temporary, file);
  } catch (error) {
    removeTemporary(temporary);
    throw error;
  }
}

function placedWidget(text, area) {
  const stored = storedPlacement(text, area);
  const frame = widgetFrame(stored.expanded);
  const placed = clampPosition(stored, area, frame);
  return { x: placed.x, y: placed.y, width: frame.width, height: frame.height, expanded: frame.expanded };
}

function boxUsable(box) {
  return Boolean(box)
    && Number.isFinite(box.x)
    && Number.isFinite(box.y)
    && Number.isFinite(box.width)
    && Number.isFinite(box.height)
    && box.width > 0
    && box.height > 0;
}

function fallbackDisplay() {
  const box = { x: 0, y: 0, width: WIDGET_WIDTH, height: WIDGET_HEIGHT };
  return { id: 'fallback', bounds: box, workArea: box };
}

function connectedDisplays(displays) {
  const usable = Array.isArray(displays) ? displays.filter((display) => boxUsable(display && display.workArea)) : [];
  return usable.length > 0 ? usable : [fallbackDisplay()];
}

function containsPoint(box, point) {
  return point.x >= box.x && point.y >= box.y && point.x < box.x + box.width && point.y < box.y + box.height;
}

function displayFor(point, displays) {
  const connected = connectedDisplays(displays);
  const primary = connected[0];
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return primary;
  const owner = connected.find((display) => {
    if (boxUsable(display.bounds) && containsPoint(display.bounds, point)) return true;
    return containsPoint(display.workArea, point);
  });
  return owner || primary;
}

function placedWidgetOnDisplays(text, displays) {
  const primary = connectedDisplays(displays)[0];
  const stored = storedPlacement(text, primary.workArea);
  const frame = widgetFrame(stored.expanded);
  const display = displayFor(stored, displays);
  const placed = clampPosition(stored, display.workArea, frame);
  return {
    x: placed.x,
    y: placed.y,
    width: frame.width,
    height: frame.height,
    expanded: frame.expanded,
    displayId: String(display.id),
  };
}

module.exports = {
  clampPosition,
  widgetFrame,
  placedWidget,
  placedWidgetOnDisplays,
  readWidgetPosition,
  saveWidgetPosition,
  WIDGET_WIDTH,
  WIDGET_HEIGHT,
  WIDGET_EXPANDED_WIDTH,
  WIDGET_EXPANDED_HEIGHT,
  MOVE_DEBOUNCE_MS,
};
