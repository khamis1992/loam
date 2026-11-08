import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { validateProject } from '../../mobile/store.js';
import { materialize } from '../materialize.js';
import { mobileBrief, mobileProfile } from '../mobile/profile.js';
import { starterMobile } from '../mobile/fixture.js';
import { createMobilePorts } from '../mobile/ports.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { simulationDocument } from '../mobile/simulation.js';

test('mobile: fixed capability boundary', () => {
  assert.equal(mobileProfile.kind, 'mobile');
  assert.equal(mobileProfile.preview, 'device-frame');
  assert.equal(mobileProfile.externalEffects, 'approval-required');
  assert.ok(mobileProfile.exports.includes('source-zip'));
  assert.ok(mobileBrief.length > 40);
});

test('fixture uses current mobile schema, no invented DSL', () => {
  const mobile = starterMobile();
  const clean = validateProject(mobile);
  assert.equal(clean.direction, 'rtl');
  assert.equal(clean.screens[0]?.kind, 'primary');
  assert.equal(clean.screens[0]?.blocks[0]?.type, 'input');
});

test('the web simulation keeps the note locally and is not a native device', () => {
  const project = { ...validateProject(starterMobile()), revision: 1 };
  const html = simulationDocument(project);
  assert.match(html, /محاكاة الويب — ليست محاكياً أصلياً\. تصدير المصدر ليس ملف APK/);
  assert.equal(html.includes('postMessage'), false);
  assert.equal(/https?:\/\//i.test(html), false);
  const storage = new Map<string, string>();
  const first = run(html, storage);
  first.note.value = 'تذكرة';
  first.note.dispatchEvent(new first.Event('input'));
  first.done.checked = true;
  first.done.dispatchEvent(new first.Event('change'));
  const second = run(html, storage);
  assert.equal(second.note.value, 'تذكرة');
  assert.equal(second.done.checked, true);
  const broken = run(html, new Map([['loam-sim', '{bad']]));
  assert.equal(broken.note.value, '');
  assert.equal(broken.done.checked, false);
  const poisoned = new Map([['loam-sim', JSON.stringify({ note: 'تذكرة', extra: 'سر', done: 'yes' })]]);
  const cleaned = run(html, poisoned);
  assert.equal(cleaned.note.value, 'تذكرة');
  assert.equal(cleaned.done.checked, false);
  const stored = JSON.parse(poisoned.get('loam-sim') ?? '{}') as { note?: string; extra?: string; done?: boolean };
  assert.equal(stored.note, 'تذكرة');
  assert.equal(stored.done, false);
  assert.equal(stored.extra, undefined);
  const longStore = new Map([['loam-sim', JSON.stringify({ note: 'م'.repeat(600) })]]);
  const trimmed = run(html, longStore);
  assert.equal(trimmed.note.value.length, 500);
  trimmed.note.value = 'ب'.repeat(600);
  trimmed.note.dispatchEvent(new trimmed.Event('input'));
  const typed = JSON.parse(longStore.get('loam-sim') ?? '{}') as { note?: string };
  assert.equal(typed.note?.length, 500);
  assert.equal(trimmed.note.value.length, 500);
});

function runScreens(html: string, storage: Map<string, string>): { visible: () => string; back: { hidden: boolean; click: () => void }; go: (id: string) => void } {
  const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));
  const screens = ['home', 'detail'].map((id) => ({
    hidden: true,
    getAttribute: (name: string) => (name === 'data-screen' ? id : ''),
  }));
  const buttons = new Map<string, { click: () => void }>();
  const back = {
    hidden: true,
    listener: undefined as (() => void) | undefined,
    addEventListener(_type: string, fn: () => void) { back.listener = fn; },
    click() { back.listener?.(); },
  };
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  };
  vm.runInNewContext(script, {
    localStorage,
    JSON,
    document: {
      getElementById: (id: string) => (id === 'back' ? back : { textContent: '[]' }),
      querySelectorAll: (selector: string) => {
        if (selector === '[data-screen]') return screens;
        if (selector === '[data-goto]') {
          return ['home', 'detail'].map((id) => ({
            getAttribute: () => id,
            addEventListener: (_type: string, fn: () => void) => { buttons.set(id, { click: fn }); },
          }));
        }
        return [];
      },
      querySelector: () => null,
    },
  });
  return { visible: () => screens.find((screen) => !screen.hidden)?.getAttribute('data-screen') ?? '', back, go: (id) => buttons.get(id)?.click() };
}

function run(html: string, storage: Map<string, string>): { note: { value: string; dispatchEvent(event: unknown): void }; done: { checked: boolean; dispatchEvent(event: unknown): void }; Event: new (type: string) => object } {
  const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));
  const fields = new Map<string, { type: string; value: string; checked: boolean; listeners: Record<string, () => void>; getAttribute(name: string): string; addEventListener(type: string, fn: () => void): void; dispatchEvent(event: { type: string }): void }>();
  const note = field('note', 'text');
  const done = field('done', 'checkbox');
  fields.set('note', note);
  fields.set('done', done);
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  };
  class Event { constructor(public type: string) {} }
  vm.runInNewContext(script, {
    localStorage,
    JSON,
    document: {
      querySelectorAll: () => [...fields.values()],
      getElementById: () => ({ hidden: true, textContent: '[]', addEventListener() {} }),
    },
  });
  return { note, done, Event };
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
}

test('the web simulation returns to the previous screen', () => {
  const base = starterMobile();
  const project = {
    ...base,
    screens: [...base.screens, { id: 'detail', title: 'تفصيل', kind: 'primary' as const, blocks: [] }],
  };
  const html = simulationDocument(project);
  assert.match(html, /id="back"/);
  assert.match(html, />رجوع</);
  const storage = new Map<string, string>();
  const first = runScreens(html, storage);
  assert.equal(first.visible(), 'home');
  assert.equal(first.back.hidden, true);
  first.go('detail');
  assert.equal(first.visible(), 'detail');
  assert.equal(first.back.hidden, false);
  first.back.click();
  assert.equal(first.visible(), 'home');
  assert.equal(first.back.hidden, true);
  assert.equal(runScreens(html, storage).visible(), 'home');
  first.go('detail');
  const reopened = runScreens(html, storage);
  assert.equal(reopened.visible(), 'detail');
  assert.equal(reopened.back.hidden, false);
  reopened.back.click();
  assert.equal(reopened.visible(), 'home');
  assert.equal(reopened.back.hidden, true);
  storage.set('loam-sim-screen', 'detail');
  storage.set('loam-sim-stack', '{bad');
  const broken = runScreens(html, storage);
  assert.equal(broken.visible(), 'detail');
  assert.equal(broken.back.hidden, true);
});

test('mobile source export is project source and does not include an APK', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-mobile-src-'));
  const ports = createMobilePorts({ leases: new ProcessLeaseRegistry(200) });
  const selection: BuildManifest['selection'] = { kind: 'mobile' };
  const ctx: BuildJobContext = {
    workspace: root,
    jobId: 'job_mobile_source',
    operation: { action: 'package', format: 'source-zip' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 3,
      selection,
      title: 'جوال',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
  try {
    materialize({ selection, workspace: root, title: 'جوال' });
    const artifact = await ports.export(ctx, 'source-zip');
    const bytes = fs.readFileSync(path.join(root, artifact.relativePath));
    const files = unzip(bytes);
    const names = [...files.keys()];
    assert.equal(names.some((name) => name.startsWith('android/')), true);
    assert.equal(names.some((name) => name.startsWith('expo/')), true);
    assert.equal(names.includes('index.html'), true);
    assert.equal(names.includes('mobile.json'), true);
    assert.match(files.get('README.md')?.toString('utf8') ?? '', /not an APK/);
    assert.equal(names.some((name) => name.endsWith('.apk')), false);
    const note = JSON.parse(fs.readFileSync(path.join(root, '.loam', 'build-menu', 'artifacts', `${artifact.artifactId}.source.json`), 'utf8')) as { mobileRevision: number; manifestRevision: number; sourceSha256: string; apkIncluded: boolean };
    assert.equal(note.mobileRevision, 1);
    assert.equal(note.manifestRevision, 3);
    assert.equal(note.apkIncluded, false);
    assert.equal(note.sourceSha256, createHash('sha256').update(bytes).digest('hex'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function unzip(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressed = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    const body = buffer.subarray(start, start + compressed);
    files.set(name, method === 0 ? Buffer.from(body) : zlib.inflateRawSync(body));
    offset = start + compressed;
  }
  return files;
}
