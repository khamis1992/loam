import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { STEP_SOURCE, gameDocument, startState, type PlayInput, type PlayState } from '../games/page.js';
import { gameScene } from '../games/scene.js';

const PAUSE_WORD = '\u0627\u0644\u0625\u064a\u0642\u0627\u0641';
const ENGINE_NOTE = 'هذه لعبة لوحة محلية. لم يُثبَّت محرك ألعاب.';
const HELP = `الأسهم للحركة، المسافة للقفز، ${PAUSE_WORD}: Escape أو P، R للإعادة.`;

test('Escape or P freezes motion until R restarts play and right moves again', () => {
  const html = gameDocument();
  assert.equal(html.includes(`<p>${HELP}</p>`), true);
  assert.equal(html.includes(PAUSE_WORD), true);
  assert.equal(html.includes(`<p id="engine-note">${ENGINE_NOTE}</p>`), true);
  assert.equal(html.toLowerCase().includes('phaser'), false);

  for (const pauseKey of ['Escape', 'p', 'P']) {
    const page = openGame(html);
    assert.equal(page.listeners(), 5);
    assert.deepEqual(page.place(), { x: 70, y: 500, status: 'play', paused: false });
    page.keydown('ArrowRight');
    page.pump(4);
    assert.equal(page.place().x, 102);
    assert.equal(page.place().y, 500);
    page.keydown(pauseKey);
    assert.equal(page.paused(), true);
    assert.equal(page.statusText(), 'إيقاف');
    page.pump(4);
    assert.deepEqual(page.place(), { x: 102, y: 500, status: 'play', paused: true });
    page.keydown(pauseKey, true);
    page.pump(2);
    assert.equal(page.place().x, 102);
    assert.equal(page.paused(), true);
    page.keydown(pauseKey === 'P' ? 'R' : 'r');
    assert.deepEqual(page.place(), { x: 70, y: 500, status: 'play', paused: false });
    assert.equal(page.statusText(), '');
    page.pump(3);
    assert.equal(page.place().x, 70);
    page.keydown('ArrowRight');
    page.pump(4);
    assert.equal(page.place().x, 102);
    assert.equal(page.place().status, 'play');
    page.keyup('ArrowRight');
    const held = page.place().x;
    page.pump(3);
    assert.equal(page.place().x, held);
  }
});

test('R during play restarts at the start and a later right input moves', () => {
  const page = openGame(gameDocument());
  page.keydown('ArrowRight');
  page.pump(4);
  assert.equal(page.place().x, 102);
  page.keydown('r');
  assert.deepEqual(page.place(), { x: 70, y: 500, status: 'play', paused: false });
  page.pump(3);
  assert.equal(page.place().x, 70);
  page.keydown('ArrowRight');
  page.pump(4);
  assert.equal(page.place().x, 102);
  assert.equal(page.place().y, 500);
  assert.equal(page.place().status, 'play');
});

test('goal, jump, and speed or gravity ranges stay unchanged', () => {
  assert.match(STEP_SOURCE, /const speed = Math\.min\(500, Math\.max\(50, Number\(tuning\.speed\)\)\);/);
  assert.match(STEP_SOURCE, /const gravity = Math\.min\(1500, Math\.max\(100, Number\(tuning\.gravity\)\)\);/);
  assert.match(STEP_SOURCE, /const goalX = tuning\.goalX === 420 \? 420 : 600;/);
  assert.match(STEP_SOURCE, /vy = input\.jump \? -8 : 0;/);
  assert.match(STEP_SOURCE, /function restart\(\) \{ return \{ x: 70, y: 500, vy: 0, status: 'play' \}; \}/);
  const page = gameDocument();
  assert.match(page, /id="speed" type="range" min="50" max="500" value="200"/);
  assert.match(page, /id="gravity" type="range" min="100" max="1500" value="700"/);
  assert.equal(page.includes('const GOAL=600'), true);
  assert.equal(gameDocument('لعبة', gameScene('هدف قريب')).includes('const GOAL=420'), true);
  assert.equal(gameDocument('لعبة', gameScene('هدف بعيد')).includes('const GOAL=600'), true);

  const tuning = { speed: 200, gravity: 700, goalX: 600 as const };
  const walked = runStep(startState(), { left: false, right: true, jump: false }, tuning);
  assert.equal(walked.x, 78);
  assert.equal(walked.y, 500);
  assert.equal(walked.status, 'play');
  const jumped = runStep(startState(), { left: false, right: false, jump: true }, tuning);
  assert.equal(jumped.vy, -8);
  assert.equal(jumped.y, 500);
  assert.equal(jumped.status, 'play');
  const fast = runStep(startState(), { left: false, right: true, jump: false }, { ...tuning, speed: 99999 });
  assert.equal(fast.x, 70 + 500 / 25);
  const slow = runStep(startState(), { left: false, right: true, jump: false }, { ...tuning, speed: 1 });
  assert.equal(slow.x, 70 + 50 / 25);
  const heavy = runStep({ x: 70, y: 400, vy: 0, status: 'play' }, { left: false, right: false, jump: false }, { ...tuning, gravity: 99999 });
  assert.equal(heavy.vy, 1500 / 700);
  const light = runStep({ x: 70, y: 400, vy: 0, status: 'play' }, { left: false, right: false, jump: false }, { ...tuning, gravity: 1 });
  assert.equal(light.vy, 100 / 700);

  const near = playUntil(420, () => ({ left: false, right: true, jump: false }));
  assert.equal(near.status, 'goal');
  assert.equal(near.x > 420 && near.x < 540, true);
  const far = playUntil(600, () => ({ left: false, right: true, jump: false }));
  assert.equal(far.status, 'loss');
  assert.equal(runStep(near, { left: false, right: true, jump: false }, { speed: 200, gravity: 700, goalX: 420 }).status, 'goal');
  const again = run(STEP_SOURCE, 'restart()') as PlayState;
  assert.equal(again.x, 70);
  assert.equal(again.y, 500);
  assert.equal(again.status, 'play');
});

interface PreviewEvent {
  key?: string;
  repeat?: boolean;
  target?: { tagName?: string };
  preventDefault?: () => void;
}

function openGame(html: string) {
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  if (!script) throw new Error('missing_script');
  const handlers = new Map<string, Array<(event: PreviewEvent) => void>>();
  let pending: (() => void) | null = null;
  const status = { textContent: '' };
  const field = () => ({
    value: '',
    tagName: 'INPUT',
    addEventListener() {},
    removeEventListener() {},
  });
  const speed = field();
  speed.value = '200';
  const gravity = field();
  gravity.value = '700';
  const windowHost = {
    __listeners: 0,
    __frames: 0,
    __x: 0,
    __y: 0,
    __status: '',
    __paused: false,
    __errors: [] as string[],
    onerror: null as ((message: string) => void) | null,
    addEventListener(type: string, fn: (event: PreviewEvent) => void) {
      const list = handlers.get(type) ?? [];
      list.push(fn);
      handlers.set(type, list);
    },
    removeEventListener(type: string, fn: (event: PreviewEvent) => void) {
      const list = handlers.get(type) ?? [];
      handlers.set(type, list.filter((item) => item !== fn));
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
        if (id === 'status') return status;
        return { textContent: '' };
      },
    },
    localStorage: { getItem: () => null, setItem() {} },
    fetch(url: string) {
      const body = url === '/tuning.json' ? '{"speed":200,"gravity":700}' : '';
      return Promise.resolve({ text: () => Promise.resolve(body) });
    },
    requestAnimationFrame(fn: () => void) {
      pending = fn;
      return 1;
    },
    cancelAnimationFrame() {
      pending = null;
    },
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  const fire = (type: string, key: string, repeat = false) => {
    const event: PreviewEvent = {
      key,
      repeat,
      target: { tagName: 'CANVAS' },
      preventDefault() {},
    };
    for (const fn of [...(handlers.get(type) ?? [])]) fn(event);
  };
  return {
    listeners: () => windowHost.__listeners,
    paused: () => windowHost.__paused,
    statusText: () => status.textContent,
    place: () => ({ x: windowHost.__x, y: windowHost.__y, status: windowHost.__status, paused: windowHost.__paused }),
    keydown(key: string, repeat = false) { fire('keydown', key, repeat); },
    keyup(key: string) { fire('keyup', key); },
    pump(count: number) {
      for (let index = 0; index < count; index += 1) {
        const next = pending;
        if (!next) break;
        pending = null;
        next();
      }
    },
  };
}

function playUntil(goalX: 420 | 600, inputFor: (state: PlayState) => PlayInput): PlayState {
  let state = startState();
  for (let frame = 0; frame < 400 && state.status === 'play'; frame += 1) {
    state = runStep(state, inputFor(state), { speed: 200, gravity: 700, goalX });
  }
  return state;
}

function runStep(state: PlayState, input: PlayInput, tuning: { speed: number; gravity: number; goalX?: number }): PlayState {
  return run(STEP_SOURCE, `step(${JSON.stringify(state)}, ${JSON.stringify(input)}, ${JSON.stringify(tuning)})`) as PlayState;
}

function run(source: string, expression: string): unknown {
  const context = vm.createContext({});
  vm.runInContext(`${source}; result = ${expression};`, context);
  return (context as { result: unknown }).result;
}
