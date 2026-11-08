import fs from 'node:fs';
import path from 'node:path';

export const WIDGET_WIDTH = 320;
export const WIDGET_HEIGHT = 220;
export const WIDGET_EXPANDED_WIDTH = 480;
export const WIDGET_EXPANDED_HEIGHT = 360;
export const MOVE_DEBOUNCE_MS = 250;

export interface DisplayBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayBounds {
  id: string;
  bounds: DisplayBox;
  workArea: DisplayBox;
}

export interface WidgetGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  expanded: boolean;
  displayId: string;
}

export interface WidgetMoveSaver {
  move(point: { x: number; y: number; expanded?: boolean }): void;
  cancel(): void;
}

interface StoredPoint {
  x: number;
  y: number;
  expanded: boolean;
}

export function widgetFrame(expanded: boolean): { width: number; height: number; expanded: boolean } {
  if (expanded) return { width: WIDGET_EXPANDED_WIDTH, height: WIDGET_EXPANDED_HEIGHT, expanded: true };
  return { width: WIDGET_WIDTH, height: WIDGET_HEIGHT, expanded: false };
}

export function placedWidget(
  text: string,
  area: DisplayBox,
): { x: number; y: number; width: number; height: number; expanded: boolean } {
  const stored = storedPlacement(text, area);
  const frame = widgetFrame(stored.expanded);
  const placed = clampPosition(stored, area, frame);
  return { x: placed.x, y: placed.y, width: frame.width, height: frame.height, expanded: frame.expanded };
}

export function defaultWidgetGeometry(displays: readonly DisplayBounds[]): WidgetGeometry {
  return resolveWidgetGeometry('', displays);
}

export function resolveWidgetGeometry(savedText: string, displays: readonly DisplayBounds[]): WidgetGeometry {
  const primary = primaryDisplay(displays);
  const stored = readStored(savedText, { x: primary.workArea.x, y: primary.workArea.y, expanded: false });
  return placeOnDisplays(stored, displays);
}

export function createWidgetMoveSaver(deps: {
  displays: () => readonly DisplayBounds[];
  write: (text: string) => void;
}): WidgetMoveSaver {
  let cancelPending: (() => void) | null = null;
  let latest: StoredPoint | null = null;
  const cancel = (): void => {
    if (cancelPending === null) return;
    cancelPending();
    cancelPending = null;
  };
  return {
    cancel,
    move(point) {
      latest = { x: point.x, y: point.y, expanded: point.expanded === true };
      cancel();
      cancelPending = schedule(() => {
        cancelPending = null;
        const pending = latest;
        if (pending === null) return;
        deps.write(serializePlacement(placeOnDisplays(pending, deps.displays())));
      }, MOVE_DEBOUNCE_MS);
    },
  };
}

export function clampPosition(
  point: { x: number; y: number },
  area: DisplayBox,
  size: { width: number; height: number } = { width: WIDGET_WIDTH, height: WIDGET_HEIGHT },
): { x: number; y: number } {
  const x = Number.isFinite(point.x) ? point.x : area.x;
  const y = Number.isFinite(point.y) ? point.y : area.y;
  return {
    x: Math.min(Math.max(x, area.x), Math.max(area.x, area.x + area.width - size.width)),
    y: Math.min(Math.max(y, area.y), Math.max(area.y, area.y + area.height - size.height)),
  };
}

function storedPlacement(text: string, area: { x: number; y: number }): StoredPoint {
  return readStored(text, { x: area.x, y: area.y, expanded: false });
}

function readStored(text: string, fallback: StoredPoint): StoredPoint {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return fallback;
    const record = parsed as { x?: unknown; y?: unknown; expanded?: unknown };
    if (!finiteNumber(record.x) || !finiteNumber(record.y)) return fallback;
    return { x: record.x, y: record.y, expanded: record.expanded === true };
  } catch {
    return fallback;
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function placeOnDisplays(point: StoredPoint, displays: readonly DisplayBounds[]): WidgetGeometry {
  const frame = widgetFrame(point.expanded);
  const display = displayFor(point, displays);
  const placed = clampPosition(point, display.workArea, frame);
  return {
    x: placed.x,
    y: placed.y,
    width: frame.width,
    height: frame.height,
    expanded: frame.expanded,
    displayId: display.id,
  };
}

function displayFor(point: { x: number; y: number }, displays: readonly DisplayBounds[]): DisplayBounds {
  const connected = connectedDisplays(displays);
  const primary = connected[0] ?? fallbackDisplay();
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return primary;
  const owner = connected.find((display) => ownsPoint(display, point));
  return owner ?? primary;
}

function ownsPoint(display: DisplayBounds, point: { x: number; y: number }): boolean {
  if (boxUsable(display.bounds) && containsPoint(display.bounds, point)) return true;
  return containsPoint(display.workArea, point);
}

function containsPoint(box: DisplayBox, point: { x: number; y: number }): boolean {
  return point.x >= box.x
    && point.y >= box.y
    && point.x < box.x + box.width
    && point.y < box.y + box.height;
}

function connectedDisplays(displays: readonly DisplayBounds[]): readonly DisplayBounds[] {
  const usable = displays.filter((display) => boxUsable(display.workArea));
  if (usable.length > 0) return usable;
  return [fallbackDisplay()];
}

function primaryDisplay(displays: readonly DisplayBounds[]): DisplayBounds {
  return connectedDisplays(displays)[0] ?? fallbackDisplay();
}

function fallbackDisplay(): DisplayBounds {
  const box = { x: 0, y: 0, width: WIDGET_WIDTH, height: WIDGET_HEIGHT };
  return { id: 'fallback', bounds: box, workArea: box };
}

function boxUsable(box: DisplayBox): boolean {
  return Number.isFinite(box.x)
    && Number.isFinite(box.y)
    && Number.isFinite(box.width)
    && Number.isFinite(box.height)
    && box.width > 0
    && box.height > 0;
}

function serializeStored(point: { x: number; y: number; expanded: boolean }): string {
  const record = point.expanded
    ? { x: point.x, y: point.y, expanded: true }
    : { x: point.x, y: point.y };
  return `${JSON.stringify(record)}\n`;
}

function serializePlacement(geometry: WidgetGeometry): string {
  return serializeStored(geometry);
}

function schedule(run: () => void, delayMs: number): () => void {
  const handle = setTimeout(run, delayMs);
  return () => {
    clearTimeout(handle);
  };
}

const POSITION_NAME = 'widget-window.json';
const REMOTE_SCHEME = /https?\s*:\/\/|javascript\s*:|data\s*:|file\s*:|blob\s*:|mailto\s*:|tel\s*:|sms\s*:|intent\s*:|market\s*:|(^|[^:])\/\//i;

export function writeWidgetPosition(appDir: string, requested: string, text: string): void {
  const file = positionTarget(appDir, requested);
  const stored = strictPosition(text);
  assertReplaceableFile(file);
  fs.writeFileSync(file, serializeStored(stored), { encoding: 'utf8', mode: 0o600 });
  const written = fs.lstatSync(file);
  if (written.isSymbolicLink() || !written.isFile()) throw new Error('unsafe_path');
}

function positionTarget(appDir: string, requested: string): string {
  if (typeof appDir !== 'string' || typeof requested !== 'string') throw new Error('invalid_request');
  if (appDir.length === 0 || requested.length === 0) throw new Error('unsafe_path');
  if (appDir.includes('\0') || requested.includes('\0')) throw new Error('unsafe_path');
  const root = path.resolve(appDir);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(root);
  } catch {
    throw new Error('unsafe_path');
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('unsafe_path');
  const target = path.resolve(root, requested);
  if (path.relative(root, target) !== POSITION_NAME) throw new Error('unsafe_path');
  return target;
}

function assertReplaceableFile(file: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw new Error('unsafe_path');
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

function strictPosition(text: string): StoredPoint {
  if (typeof text !== 'string') throw new Error('invalid_request');
  if (containsRemote(text)) throw new Error('unsafe_path');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('invalid_request');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_request');
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  const compact = keys.length === 2 && Object.hasOwn(record, 'x') && Object.hasOwn(record, 'y');
  const opened = keys.length === 3
    && Object.hasOwn(record, 'x')
    && Object.hasOwn(record, 'y')
    && Object.hasOwn(record, 'expanded')
    && record.expanded === true;
  if (!compact && !opened) throw new Error('invalid_request');
  if (!finiteNumber(record.x) || !finiteNumber(record.y)) throw new Error('invalid_request');
  return { x: record.x, y: record.y, expanded: record.expanded === true };
}

function containsRemote(text: string): boolean {
  if (remoteText(text)) return true;
  try {
    const parsed: unknown = JSON.parse(text);
    const strings: string[] = [];
    collectStrings(parsed, strings);
    return strings.some((value) => remoteText(value));
  } catch {
    return false;
  }
}

function collectStrings(value: unknown, found: string[]): void {
  if (typeof value === 'string') {
    found.push(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, found);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    found.push(key);
    collectStrings(record[key], found);
  }
}

function remoteText(text: string): boolean {
  let pending = [text];
  const seen = new Set<string>();
  for (let depth = 0; depth <= 2; depth += 1) {
    const layer = pending;
    pending = [];
    for (const value of layer) {
      if (seen.has(value)) continue;
      seen.add(value);
      if (formIsRemote(value)) return true;
      if (depth >= 2) continue;
      const decoded = decodePercent(value);
      if (decoded !== value) pending.push(decoded);
      const decodedCollapsed = decodePercent(collapseQuotePlus(value));
      if (decodedCollapsed !== value && decodedCollapsed !== decoded) pending.push(decodedCollapsed);
    }
  }
  return false;
}

function formIsRemote(value: string): boolean {
  return remoteForms(value).some((form) => REMOTE_SCHEME.test(form));
}

function remoteForms(value: string): string[] {
  const collapsed = collapseQuotePlus(value);
  const opened = collapsed.replace(/['"]/g, '').replace(/\+/g, '');
  const forms = [value];
  if (collapsed !== value) forms.push(collapsed);
  if (opened !== value && opened !== collapsed) forms.push(opened);
  return forms;
}

function collapseQuotePlus(value: string): string {
  let current = value;
  let previous = '';
  while (current !== previous) {
    previous = current;
    current = current.replace(/['"]\s*\+\s*['"]/g, '');
  }
  return current;
}

function decodePercent(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_whole, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}
