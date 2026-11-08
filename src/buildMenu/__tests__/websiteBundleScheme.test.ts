import test from 'node:test';
import assert from 'node:assert/strict';
import { unsafeWebsitePreview } from '../websites/bundle.js';
import { currentWebsiteHostRunner } from '../websites/hostCommand.js';
import { websiteDocument } from '../websites/page.js';

const SCHEMES = ['mailto', 'tel', 'sms', 'intent', 'market'] as const;

const TAILS: Record<(typeof SCHEMES)[number], string> = {
  mailto: 'user@example.com',
  tel: '+97455500000',
  sms: '+97455500000',
  intent: 'scan',
  market: 'details?id=app',
};

function encodeChars(value: string): string {
  return [...value].map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
}

function encodedTargets(scheme: (typeof SCHEMES)[number]): string[] {
  const tail = TAILS[scheme];
  const url = `${scheme}:${tail}`;
  return [
    `${scheme}%3a${tail}`,
    `${scheme.toUpperCase()}%3A${tail}`,
    `${scheme}%253a${tail}`,
    encodeURIComponent(url),
    encodeURIComponent(encodeURIComponent(url)).toLowerCase(),
    encodeChars(`${scheme}:`),
    encodeChars(encodeChars(`${scheme}:`)),
  ];
}

function quoteSplits(scheme: (typeof SCHEMES)[number]): string[] {
  const tail = TAILS[scheme];
  const head = scheme.slice(0, 2);
  const rest = scheme.slice(2);
  return [
    `${scheme}" + ":${tail}`,
    `${scheme}' + ':${tail}`,
    `${head}"+"${rest}:${tail}`,
    `"${scheme}"+":${tail}"`,
    `'${scheme.toUpperCase()}' + ':${tail}'`,
    `"${scheme}"+"%3a${tail}"`,
    `${scheme}%22%20+%20%22:${tail}`,
    `${scheme}&quot;+&quot;:${tail}`,
    encodeChars(`${scheme}"+":`),
  ];
}

test('the production host runner stays null', () => {
  assert.equal(currentWebsiteHostRunner(), null);
});

test('a hash action and a page with no outbound link still pass', () => {
  assert.equal(unsafeWebsitePreview('<form action="#save"></form>'), false);
  assert.equal(unsafeWebsitePreview('<a href="#notes">ملاحظة</a>'), false);
  assert.equal(unsafeWebsitePreview('<a href="">محلي</a>'), false);
  assert.equal(unsafeWebsitePreview('<form action=""></form>'), false);
  assert.equal(unsafeWebsitePreview('<button formaction="#stay">ابق</button>'), false);
  assert.equal(unsafeWebsitePreview('<p>صفحة محلية</p>'), false);
  for (const subtype of ['landing', 'store', 'booking', 'chatbot'] as const) {
    assert.equal(unsafeWebsitePreview(websiteDocument('صفحة', subtype)), false, subtype);
  }
  assert.equal(currentWebsiteHostRunner(), null);
});

test('POST forms stay rejected', () => {
  assert.equal(unsafeWebsitePreview('<form method="post"></form>'), true);
  assert.equal(unsafeWebsitePreview('<form action="#save" method="post"></form>'), true);
  assert.equal(unsafeWebsitePreview('<form method="POST" action="#save"></form>'), true);
  assert.equal(unsafeWebsitePreview('<button formmethod="post">أرسل</button>'), true);
  assert.equal(unsafeWebsitePreview('<input formmethod="POST">'), true);
});

test('percent-encoded mailto, tel, sms, intent, and market are outside the page', () => {
  for (const scheme of SCHEMES) {
    for (const target of encodedTargets(scheme)) {
      assert.equal(unsafeWebsitePreview(`<a href="${target}">x</a>`), true, `href ${target}`);
      assert.equal(unsafeWebsitePreview(`<form action="${target}"></form>`), true, `action ${target}`);
      assert.equal(unsafeWebsitePreview(`<button formaction="${target}">x</button>`), true, `formaction ${target}`);
      assert.equal(unsafeWebsitePreview(`<input formaction="${target}">`), true, `input ${target}`);
      assert.equal(unsafeWebsitePreview(`<form action="#save">${target}</form>`), true, `body ${target}`);
      assert.equal(unsafeWebsitePreview(`<p>${target}</p>`), true, `text ${target}`);
    }
  }
});

test('quote-split mailto, tel, sms, intent, and market forms are outside the page', () => {
  for (const scheme of SCHEMES) {
    const tail = TAILS[scheme];
    for (const split of quoteSplits(scheme)) {
      assert.equal(unsafeWebsitePreview(`<form action="${split}"></form>`), true, `action ${split}`);
      assert.equal(unsafeWebsitePreview(`<a href="${split}">x</a>`), true, `href ${split}`);
      assert.equal(unsafeWebsitePreview(`<form action="#save">${split}</form>`), true, `body ${split}`);
      assert.equal(unsafeWebsitePreview(`<p>${split}</p>`), true, `text ${split}`);
      assert.equal(unsafeWebsitePreview(split), true, `bare ${split}`);
    }
    assert.equal(unsafeWebsitePreview(`<form action="#"+"${scheme}:${tail}"></form>`), true, `hash concat ${scheme}`);
    assert.equal(unsafeWebsitePreview(`<form action=""+"${scheme}:${tail}"></form>`), true, `empty concat ${scheme}`);
    assert.equal(unsafeWebsitePreview(`<button formaction="#"+"${scheme}:${tail}">x</button>`), true, `button concat ${scheme}`);
  }
  assert.equal(currentWebsiteHostRunner(), null);
});
