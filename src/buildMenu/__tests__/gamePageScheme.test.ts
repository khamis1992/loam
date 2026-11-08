import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { STEP_SOURCE, gameDocument, unsafeGamePage } from '../games/page.js';

const VALID = '{"speed":200,"gravity":700}';

const SCHEMES = [
  'mailto:user@example.test',
  'MAILTO:user@example.test',
  'mailto :user@example.test',
  'tel:97400000000',
  'sms:97400000000',
  'intent:scan',
  'intent :scan',
  'market:details?id=app',
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'javascript :alert(1)',
  'https://evil.example/a',
  'http://evil.example/a',
  'HTTPS://evil.example/a',
  'HTTP://evil.example/a',
  'data:text/html,hi',
  'DATA:text/html,hi',
  'file:///c:/secret',
  'FILE:///c:/secret',
  'blob:null/uuid',
  'BLOB:null/uuid',
  '//evil.example/a',
  '//EVIL.example/a',
  'mailto%3Auser@example.test',
  'tel%3A974',
  'sms%3A974',
  'intent%3Ascan',
  'market%3Adetails',
  'javascript%3Aalert(1)',
  'JavaScript%3Aalert(1)',
  'https%3A%2F%2Fevil.example/a',
  'http%3A%2F%2Fevil.example/a',
  'http:%2F%2Fevil.example/a',
  'http%3A//evil.example/a',
  'HTTPS%3A%2F%2Fevil.example/a',
  'data%3Atext/html,hi',
  'file%3A///c:/secret',
  'blob%3Anull/uuid',
  '%2F%2Fevil.example/a',
  'mailto%253Auser@example.test',
  'tel%253A974',
  'sms%253A974',
  'intent%253Ascan',
  'market%253Adetails',
  'javascript%253Aalert(1)',
  'https%253A%252F%252Fevil.example/a',
  'http%253A%252F%252Fevil.example/a',
  'http:%252F%252Fevil.example/a',
  'data%253Atext/html,hi',
  'file%253A///c:/secret',
  'blob%253Anull/uuid',
  '%252F%252Fevil.example/a',
  'java%73cript:alert(1)',
  'java%2573cript%253Aalert(1)',
  '"mailto"+":"',
  '"tel"+":"',
  '"sms"+":"',
  '"intent"+":"',
  '"market"+":"',
  '"javascript"+":"',
  '"java"+"script:"',
  "javascript'+':alert(1)",
  '"https"+"://evil.example/a"',
  '"http"+"://evil.example/a"',
  '"http"+"//evil.example/a"',
  "https'+'://evil.example/a",
  '"https" + "://evil.example/a"',
  '"data"+":"',
  '"file"+":///c:/secret"',
  '"blob"+":"',
  '"mail"+"to:"',
  '"/"+"/"',
  '%22javascript%22%2B%22%3A%22',
  '%2522javascript%2522%252B%2522%253A%2522',
  '%22http%22%2B%22%3A%2F%2Fevil.example%22',
  '%2522https%2522%252B%2522%253A%252F%252Fevil.example%2522',
];

function payload(scheme: string): string {
  return `{"speed":450,"gravity":1200,"next":${JSON.stringify(scheme)}}`;
}

test('a normal tuning payload still applies and page bounds stay put', async () => {
  assert.match(STEP_SOURCE, /const speed = Math\.min\(500, Math\.max\(50, Number\(tuning\.speed\)\)\);/);
  assert.match(STEP_SOURCE, /const gravity = Math\.min\(1500, Math\.max\(100, Number\(tuning\.gravity\)\)\);/);
  assert.match(STEP_SOURCE, /const goalX = tuning\.goalX === 420 \? 420 : 600;/);
  assert.match(STEP_SOURCE, /function restart\(\) \{ return \{ x: 70, y: 500, vy: 0, status: 'play' \}; \}/);
  const html = gameDocument();
  assert.equal(unsafeGamePage(html), false);
  assert.match(html, /id="speed" type="range" min="50" max="500" value="200"/);
  assert.match(html, /id="gravity" type="range" min="100" max="1500" value="700"/);
  assert.equal(html.includes('const GOAL=600'), true);
  assert.equal(html.toLowerCase().includes('phaser'), false);

  const fetched = openPage(html, { remote: VALID, stored: null });
  await fetched.settle();
  assert.equal(fetched.speed(), '200');
  assert.equal(fetched.gravity(), '700');

  const stored = openPage(html, { remote: null, stored: VALID });
  await stored.settle();
  assert.equal(stored.speed(), '200');
  assert.equal(stored.gravity(), '700');
});

test('blocked scheme payloads do not change the sliders', async () => {
  const html = gameDocument();
  for (const scheme of SCHEMES) {
    const body = payload(scheme);
    const fetched = openPage(html, { remote: body, stored: null });
    await fetched.settle();
    assert.equal(fetched.speed(), '50', scheme);
    assert.equal(fetched.gravity(), '100', scheme);

    const stored = openPage(html, { remote: null, stored: body });
    await stored.settle();
    assert.equal(stored.speed(), '50', scheme);
    assert.equal(stored.gravity(), '100', scheme);
  }
});

function openPage(html: string, options: { remote: string | null; stored: string | null }) {
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  if (!script) throw new Error('missing_script');
  const speed = element('50');
  const gravity = element('100');
  const context = {
    window: {
      __listeners: 0,
      __frames: 0,
      __errors: [] as string[],
      onerror: null as ((message: string) => void) | null,
      addEventListener() {},
      removeEventListener() {},
    },
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
    localStorage: {
      getItem() { return options.stored; },
      setItem() {},
    },
    fetch(url: string) {
      if (options.remote == null) return Promise.reject(new Error('offline'));
      if (url === '/tuning.json') return Promise.resolve({ text: () => Promise.resolve(options.remote) });
      return Promise.resolve({ text: () => Promise.resolve('') });
    },
    requestAnimationFrame() { return 1; },
    cancelAnimationFrame() {},
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  return {
    speed: () => speed.value,
    gravity: () => gravity.value,
    async settle() {
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    },
  };
}

function element(value: string) {
  return {
    value,
    tagName: 'INPUT',
    addEventListener() {},
    removeEventListener() {},
  };
}
