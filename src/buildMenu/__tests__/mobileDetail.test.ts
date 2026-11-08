import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { validateProject, type MobileProject } from '../../mobile/store.js';
import { starterMobile } from '../mobile/fixture.js';
import { simulationDocument } from '../mobile/simulation.js';

test('detail back returns to the parent when the trail is empty', () => {
  const html = simulationDocument(detailProject());
  assert.match(html, /محاكاة الويب — ليست محاكياً أصلياً\. تصدير المصدر ليس ملف APK/);
  assert.match(html, /data-screen="item" data-parent="home"/);
  assert.equal(html.includes('postMessage'), false);
  assert.equal(/<script\b[^>]*\ssrc\s*=/i.test(html), false);
  const storage = new Map<string, string>();
  const first = run(html, storage);
  assert.equal(first.visible(), 'home');
  assert.equal(first.back.hidden, true);
  first.note.value = 'تذكرة';
  first.note.dispatchEvent({ type: 'input' });
  first.go('item');
  assert.equal(first.visible(), 'item');
  assert.equal(first.back.hidden, false);
  first.back.click();
  assert.equal(first.visible(), 'home');
  assert.equal(first.back.hidden, true);
  first.go('item');
  storage.set('loam-sim-stack', '[]');
  const reopened = run(html, storage);
  assert.equal(reopened.visible(), 'item');
  assert.equal(reopened.note.value, 'تذكرة');
  assert.equal(reopened.back.hidden, false);
  reopened.back.click();
  assert.equal(reopened.visible(), 'home');
  assert.equal(reopened.back.hidden, true);
  assert.equal(reopened.note.value, 'تذكرة');
});

test('a broken mobile target or detail parent is refused before the simulation', () => {
  const starter = starterMobile();
  const home = starter.screens[0];
  if (!home) throw new Error('missing home');
  assert.throws(
    () => simulationDocument({
      ...starter,
      screens: [{ ...home, blocks: [...home.blocks, { id: 'open', type: 'button', text: 'مفقود', target: 'missing' }] }],
    }),
    /tool_failed/,
  );
  assert.throws(
    () => simulationDocument({
      ...starter,
      screens: [home, { id: 'item', title: 'تفصيل', kind: 'detail', blocks: [] }],
    }),
    /tool_failed/,
  );
  assert.throws(
    () => simulationDocument({
      ...starter,
      screens: [
        home,
        { id: 'item', title: 'تفصيل', kind: 'detail', parentId: 'more', blocks: [] },
        { id: 'more', title: 'أخرى', kind: 'detail', parentId: 'item', blocks: [] },
      ],
    }),
    /tool_failed/,
  );
});

function detailProject(): MobileProject {
  const starter = starterMobile();
  const home = starter.screens[0];
  if (!home) throw new Error('missing home');
  return {
    ...validateProject({
      ...starter,
      screens: [
        { ...home, blocks: [...home.blocks, { id: 'open', type: 'button', text: 'التفاصيل', target: 'item' }] },
        { id: 'item', title: 'تفصيل', kind: 'detail', parentId: 'home', blocks: [{ id: 'body', type: 'text', text: 'تفاصيل الملاحظة' }] },
      ],
    }),
    revision: 1,
  };
}

function run(html: string, storage: Map<string, string>): {
  visible: () => string;
  back: { hidden: boolean; click: () => void };
  go: (id: string) => void;
  note: { value: string; dispatchEvent(event: { type: string }): void };
} {
  const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const screens = [
    { id: 'home', parent: null as string | null },
    { id: 'item', parent: 'home' },
  ].map((screen) => ({
    hidden: true,
    getAttribute(name: string) {
      if (name === 'data-screen') return screen.id;
      if (name === 'data-parent') return screen.parent;
      return null;
    },
  }));
  const buttons = new Map<string, { click: () => void }>();
  const back = {
    hidden: true,
    listener: undefined as (() => void) | undefined,
    addEventListener(_type: string, fn: () => void) { back.listener = fn; },
    click() { back.listener?.(); },
  };
  const note = field('note', 'text');
  const done = field('done', 'checkbox');
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  };
  vm.runInNewContext(script, {
    localStorage,
    JSON,
    document: {
      documentElement: { getAttribute: () => 'portrait', setAttribute() {} },
      getElementById: (id: string) => {
        if (id === 'back') return back;
        if (id === 'loam-collections') return { textContent: '[]' };
        if (id === 'rotate') return { getAttribute: () => 'portrait', addEventListener() {} };
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector === '[data-field]') return [note, done];
        if (selector === '[data-screen]') return screens;
        if (selector === '[data-goto]') {
          return ['home', 'item'].map((id) => ({
            getAttribute: () => id,
            addEventListener: (_type: string, fn: () => void) => { buttons.set(id, { click: fn }); },
          }));
        }
        return [];
      },
      querySelector: () => null,
    },
  });
  return {
    visible: () => screens.find((screen) => !screen.hidden)?.getAttribute('data-screen') ?? '',
    back,
    go: (id) => buttons.get(id)?.click(),
    note,
  };
}

function field(id: string, type: string) {
  const node = {
    type,
    value: '',
    checked: false,
    listeners: {} as Record<string, () => void>,
    getAttribute: (name: string) => (name === 'data-field' ? id : ''),
    addEventListener: (event: string, fn: () => void) => { node.listeners[event] = fn; },
    dispatchEvent: (event: { type: string }) => { node.listeners[event.type]?.(); },
  };
  return node;
}
