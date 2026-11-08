import test from 'node:test';
import assert from 'node:assert/strict';
import type { MobileProject } from '../../mobile/store.js';
import { starterMobile } from '../mobile/fixture.js';
import { simulationDocument } from '../mobile/simulation.js';

const NOTICE = /محاكاة الويب — ليست محاكياً أصلياً\. تصدير المصدر ليس ملف APK\./;
const SVG = 'http://www.w3.org/2000/svg';
const SCHEMES = ['mailto', 'tel', 'sms', 'intent', 'market'] as const;

function withText(text: string): MobileProject {
  const project = starterMobile();
  const screen = project.screens[0];
  if (!screen) throw new Error('missing screen');
  return {
    ...project,
    title: text,
    screens: [{
      ...screen,
      title: text,
      blocks: screen.blocks.map((block, index) => (index === 0 ? { ...block, text } : block)),
    }],
  };
}

function withScreenId(id: string): MobileProject {
  const project = starterMobile();
  const screen = project.screens[0];
  if (!screen) throw new Error('missing screen');
  return { ...project, screens: [{ ...screen, id }] };
}

function svgProject(): MobileProject {
  const project = starterMobile();
  const screen = project.screens[0];
  if (!screen) throw new Error('missing screen');
  return {
    ...project,
    screens: [{
      ...screen,
      id: SVG,
      blocks: [{ id: 'mark', type: 'text', text: `'${SVG}'` }],
    }],
  };
}

function unsafePath(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function encodeChars(value: string): string {
  return [...value].map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
}

test('a web simulation still shows the notice and allows the svg namespace', () => {
  const html = simulationDocument(svgProject());
  assert.match(html, NOTICE);
  assert.match(html, /ليست محاكياً أصلياً/);
  assert.match(html, /ليس ملف APK/);
  assert.match(html, /http:\/\/www\.w3\.org\/2000\/svg/);
  assert.equal(html.includes('postMessage'), false);

  const local = simulationDocument(withText('hotel: downtown and supermarket: open'));
  assert.match(local, NOTICE);
  assert.match(local, /hotel: downtown and supermarket: open/);
  assert.match(simulationDocument(withText('send mailto later')), /send mailto later/);
  assert.match(simulationDocument(withText('note 100% done')), /note 100% done/);
  assert.match(simulationDocument(withText('unintent: stay')), /unintent: stay/);

  const hidden = simulationDocument(starterMobile(), 'mailto:user@example.test');
  assert.match(hidden, NOTICE);
  assert.equal(hidden.includes('mailto:'), false);
  assert.match(hidden, /لم يُعرض في الصفحة/);

  assert.throws(() => simulationDocument(withText('https://evil.example/a')), unsafePath);
  assert.throws(() => simulationDocument(withText('http://evil.example/a')), unsafePath);
  assert.throws(() => simulationDocument(withText('javascript:alert(1)')), unsafePath);
  assert.throws(() => simulationDocument(withText('parent.postMessage(1,"*")')), unsafePath);
  assert.throws(() => simulationDocument(withScreenId('home src=data:text/html,hi')), unsafePath);
  assert.throws(() => simulationDocument(withScreenId('home href=file:///c:/secret')), unsafePath);
  assert.throws(() => simulationDocument(withScreenId('home action=blob:null/uuid')), unsafePath);
  assert.throws(() => simulationDocument(withScreenId('https://www.w3.org/2000/svg')), unsafePath);
  assert.throws(() => simulationDocument(withScreenId('http://www.w3.org/2000/svg/extra')), unsafePath);
});

test('mailto, tel, sms, intent, and market are refused, including percent-encoding once or twice', () => {
  const payloads: string[] = [];
  for (const scheme of SCHEMES) {
    const literal = `${scheme}:user@example.test`;
    payloads.push(
      literal,
      `${scheme.toUpperCase()}:user@example.test`,
      `${scheme} :user@example.test`,
      `${scheme}%3Auser@example.test`,
      `${scheme.toUpperCase()}%3Auser@example.test`,
      `${scheme}%253Auser@example.test`,
      `${scheme.toUpperCase()}%253Auser@example.test`,
      encodeURIComponent(literal),
      encodeURIComponent(encodeURIComponent(literal)),
      encodeChars(literal),
      encodeChars(encodeChars(literal)),
      encodeChars(`${scheme.toUpperCase()}:${scheme}`),
      `href=${scheme}:open`,
      `src=${scheme}%3Aopen`,
      `action=${scheme}%253Aopen`,
    );
  }
  payloads.push('intent://scan/#Intent;end', 'market://details?id=app', 'MaIlTo:user@example.test');

  for (const payload of payloads) {
    assert.throws(() => simulationDocument(withText(payload)), unsafePath, payload);
    assert.throws(() => simulationDocument(withScreenId(`home ${payload}`)), unsafePath, payload);
  }
});
