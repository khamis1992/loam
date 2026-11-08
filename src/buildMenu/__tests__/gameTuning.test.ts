import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { gameAssetManifest } from '../games/assets.js';
import { STEP_SOURCE, gameDocument, startState, unsafeGamePage, type PlayState } from '../games/page.js';
import { gameScene } from '../games/scene.js';
import { checkedTuning, loadTuningText, readLocalTuning } from '../games/tuning.js';

test('tuning outside the declared ranges is rejected and a local file still loads', () => {
  assert.deepEqual(checkedTuning({ speed: 50, gravity: 100 }), { speed: 50, gravity: 100 });
  assert.deepEqual(checkedTuning({ speed: 500, gravity: 1500 }), { speed: 500, gravity: 1500 });
  assert.throws(() => checkedTuning({ speed: 49, gravity: 700 }), /invalid_tuning/);
  assert.throws(() => checkedTuning({ speed: 501, gravity: 700 }), /invalid_tuning/);
  assert.throws(() => checkedTuning({ speed: 200, gravity: 99 }), /invalid_tuning/);
  assert.throws(() => checkedTuning({ speed: 200, gravity: 1501 }), /invalid_tuning/);
  assert.throws(() => checkedTuning({ speed: NaN, gravity: 700 }), /invalid_tuning/);
  assert.throws(() => checkedTuning({ speed: 200, gravity: NaN }), /invalid_tuning/);
  assert.throws(() => checkedTuning({ speed: Infinity, gravity: 700 }), /invalid_tuning/);
  assert.throws(() => checkedTuning({ speed: 200, gravity: Infinity }), /invalid_tuning/);
  assert.throws(() => checkedTuning({ speed: -Infinity, gravity: 700 }), /invalid_tuning/);
  assert.throws(() => checkedTuning({ speed: '200' as unknown as number, gravity: 700 }), /invalid_tuning/);
  assert.throws(() => checkedTuning({ speed: 200, gravity: '700' as unknown as number }), /invalid_tuning/);
  assert.throws(() => loadTuningText('{"speed":"200","gravity":700}'), /invalid_tuning/);
  assert.throws(() => loadTuningText('{"speed":200,"gravity":"1500"}'), /invalid_tuning/);
  assert.throws(() => checkedTuning({ speed: 200, gravity: 700, note: 'javascript:alert(1)' } as { speed: number; gravity: number }), /invalid_tuning/);
  assert.throws(() => loadTuningText('javascript:alert(1)'), /invalid_tuning/);
  assert.throws(() => loadTuningText('{"speed":200,"gravity":700,"next":"https://evil.example/a"}'), /invalid_tuning/);
  assert.throws(() => loadTuningText('{"speed":200,"gravity":700,"next":"http://evil.example/a"}'), /invalid_tuning/);
  assert.deepEqual(loadTuningText('{"speed":200,"gravity":700}\n'), { speed: 200, gravity: 700 });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-game-tuning-file-'));
  try {
    assert.throws(() => readLocalTuning(root), /invalid_tuning/);
    fs.writeFileSync(path.join(root, 'tuning.json'), '{"speed":200,"gravity":700}\n');
    assert.deepEqual(readLocalTuning(root), { speed: 200, gravity: 700 });
    fs.writeFileSync(path.join(root, 'tuning.json'), '{"speed":99999,"gravity":700}\n');
    assert.throws(() => readLocalTuning(root), /invalid_tuning/);
    fs.writeFileSync(path.join(root, 'tuning.json'), '{"speed":200,"gravity":700,"next":"javascript:alert(1)"}\n');
    assert.throws(() => readLocalTuning(root), /invalid_tuning/);
    fs.rmSync(path.join(root, 'tuning.json'));
    fs.mkdirSync(path.join(root, 'tuning.json'));
    assert.throws(() => readLocalTuning(root), /unsafe_path/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an asset path that leaves the game folder is rejected', () => {
  const text = '{"speed":200,"gravity":700}\n';
  const manifest = gameAssetManifest([
    { path: 'index.html', text: '<canvas></canvas>' },
    { path: 'tuning.json', text },
    { path: 'LICENSE', text: 'local\n' },
  ]);
  const parsed = JSON.parse(manifest) as { assets: { path: string; evidenceSha256: string }[] };
  assert.deepEqual(parsed.assets.map((asset) => asset.path), ['index.html', 'tuning.json', 'LICENSE']);
  assert.equal(parsed.assets[1]?.evidenceSha256, createHash('sha256').update(text).digest('hex'));
  for (const filePath of ['../secret', 'assets/../../outside', '/etc/passwd', 'C:/secret', 'assets\\secret', 'javascript:alert(1)', 'https://evil.example/a.png']) {
    assert.throws(() => gameAssetManifest([{ path: filePath, text: 'x' }]), /unsafe_path/);
  }
});

test('the preview stops listening after page hide and both goals still decide the round', async () => {
  assert.equal(statusAt(420), 'goal');
  assert.equal(statusAt(600), 'loss');
  const near = gameDocument('لعبة', gameScene('هدف قريب'));
  const far = gameDocument('لعبة', gameScene('هدف بعيد'));
  assert.equal(unsafeGamePage(near), false);
  assert.equal(unsafeGamePage(far), false);
  assert.equal(near.includes('const GOAL=420'), true);
  assert.equal(far.includes('const GOAL=600'), true);

  const loaded = openPreview(far, '{"speed":320,"gravity":900}\n');
  await loaded.settle();
  assert.equal(loaded.speed(), '320');
  assert.equal(loaded.listeners(), 5);
  loaded.press('r');
  assert.equal(loaded.listeners(), 5);
  loaded.press('ArrowRight');
  assert.equal(loaded.blocked(), 2);
  assert.equal(loaded.scheduled(), true);
  loaded.hide();
  assert.equal(loaded.listeners(), 0);
  assert.equal(loaded.scheduled(), false);
  loaded.press('ArrowRight');
  assert.equal(loaded.blocked(), 2);

  const remote = openPreview(far, '{"speed":200,"gravity":700,"next":"javascript:alert(1)"}');
  await remote.settle();
  assert.equal(remote.speed(), '200');
  const url = openPreview(far, '{"speed":200,"gravity":700,"next":"https://evil.example/tune"}');
  await url.settle();
  assert.equal(url.speed(), '200');
  const high = openPreview(far, '{"speed":99999,"gravity":700}');
  await high.settle();
  assert.equal(high.speed(), '200');
});

function statusAt(goalX: 420 | 600): string {
  const tuning = checkedTuning({ speed: 200, gravity: 700 });
  let state = startState();
  const input = { left: false, right: true, jump: false };
  for (let frame = 0; frame < 400 && state.status === 'play'; frame += 1) {
    state = run(STEP_SOURCE, `step(${JSON.stringify(state)}, ${JSON.stringify(input)}, ${JSON.stringify({ ...tuning, goalX })})`) as PlayState;
  }
  return state.status;
}

function run(source: string, expression: string): unknown {
  const context = vm.createContext({});
  vm.runInContext(`${source}; result = ${expression};`, context);
  return (context as { result: unknown }).result;
}

interface PreviewEvent {
  key?: string;
  repeat?: boolean;
  target?: { tagName?: string };
  preventDefault?: () => void;
}

function openPreview(html: string, tuningText: string) {
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  if (!script) throw new Error('missing_script');
  const handlers = new Map<string, Set<(event: PreviewEvent) => void>>();
  const frame = { pending: null as (() => void) | null };
  let blocked = 0;
  const speed = element('200');
  const gravity = element('700');
  const windowHost = {
    __listeners: 0,
    __frames: 0,
    __errors: [] as string[],
    onerror: null as ((message: string) => void) | null,
    addEventListener(type: string, fn: (event: PreviewEvent) => void) {
      const set = handlers.get(type) ?? new Set<(event: PreviewEvent) => void>();
      set.add(fn);
      handlers.set(type, set);
    },
    removeEventListener(type: string, fn: (event: PreviewEvent) => void) {
      handlers.get(type)?.delete(fn);
    },
  };
  const context = {
    window: windowHost,
    document: {
      querySelector() {
        return { width: 680, height: 620, getContext() { return { fillStyle: '', fillRect() {} }; } };
      },
      getElementById(id: string) {
        if (id === 'speed') return speed;
        if (id === 'gravity') return gravity;
        return { textContent: '' };
      },
    },
    localStorage: { getItem: () => null, setItem() {} },
    fetch(url: string) {
      if (url === '/tuning.json') return Promise.resolve({ text: () => Promise.resolve(tuningText) });
      return Promise.resolve({ text: () => Promise.resolve('') });
    },
    requestAnimationFrame(fn: () => void) {
      frame.pending = fn;
      return 1;
    },
    cancelAnimationFrame() {
      frame.pending = null;
    },
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  return {
    listeners: () => windowHost.__listeners,
    speed: () => speed.value,
    scheduled: () => frame.pending !== null,
    blocked: () => blocked,
    hide() {
      for (const fn of [...(handlers.get('pagehide') ?? [])]) fn({});
    },
    press(key: string) {
      const event: PreviewEvent = {
        key,
        repeat: false,
        target: { tagName: 'CANVAS' },
        preventDefault() { blocked += 1; },
      };
      for (const fn of [...(handlers.get('keydown') ?? [])]) fn(event);
    },
    async settle() {
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    },
  };
}

function element(value: string) {
  const handlers = new Map<string, Set<(event: PreviewEvent) => void>>();
  return {
    value,
    tagName: 'INPUT',
    addEventListener(type: string, fn: (event: PreviewEvent) => void) {
      const set = handlers.get(type) ?? new Set<(event: PreviewEvent) => void>();
      set.add(fn);
      handlers.set(type, set);
    },
    removeEventListener(type: string, fn: (event: PreviewEvent) => void) {
      handlers.get(type)?.delete(fn);
    },
  };
}
