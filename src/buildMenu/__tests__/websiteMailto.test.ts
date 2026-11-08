import test from 'node:test';
import assert from 'node:assert/strict';
import { websiteDocument, type WebsitePageKind } from '../websites/page.js';

const KINDS = ['landing', 'store', 'booking', 'chatbot'] as const;
const SCHEMES = ['mailto', 'tel', 'sms', 'intent', 'market'] as const;

test('a normal landing, store, booking, and chatbot page still generates', () => {
  const expected: Record<WebsitePageKind, RegExp> = {
    landing: /صفحة هبوط محلية/,
    store: /سلة محلية/,
    booking: /محلي فقط/,
    chatbot: /<h1>دردشة<\/h1>/,
  };
  for (const subtype of KINDS) {
    const html = websiteDocument('صفحة', subtype);
    assert.match(html, /<!doctype html>/);
    assert.match(html, expected[subtype]);
    assert.equal(/(?:mailto|tel|sms|intent|market)\s*:/i.test(html), false);
  }
});

test('a relative script and a hash action still generate', () => {
  for (const subtype of KINDS) {
    const script = websiteDocument('./page.js', subtype);
    assert.match(script, /<title>\.\/page\.js<\/title>/);
    const action = websiteDocument('action="#save"', subtype);
    assert.match(action, /<title>action=&quot;#save&quot;<\/title>/);
    const scriptBrief = websiteDocument('صفحة', subtype, './page.js');
    assert.match(scriptBrief, /<pre id="brief">\.\/page\.js<\/pre>/);
    const actionBrief = websiteDocument('صفحة', subtype, 'action="#save"');
    assert.match(actionBrief, /<pre id="brief">action=&quot;#save&quot;<\/pre>/);
  }
});

test('a local brief stays in the page and words without a scheme still generate', () => {
  const shown = websiteDocument('هبوط', 'landing', 'صفحة هبوط للدفتر المحلي');
  assert.match(shown, /<pre id="brief">صفحة هبوط للدفتر المحلي<\/pre>/);
  for (const subtype of KINDS) {
    const stayed = websiteDocument('صفحة', subtype, 'data file blob');
    assert.match(stayed, /<pre id="brief">data file blob<\/pre>/);
    assert.match(websiteDocument('data: file: blob:', subtype), /<title>data: file: blob:<\/title>/);
  }
});

test('a generated website page rejects mailto, tel, sms, intent, and market schemes', () => {
  assert.equal(encodeChars('mailto:'), '%6d%61%69%6c%74%6f%3a');
  const carried = [
    'mailto%3a',
    'mailto%253a',
    'Mailto%3A',
    'href="mailto:a@b.c"',
    "src='tel:123'",
    'افتح mailto:a@b.c',
    'note %6d%61%69%6c%74%6f%3a end',
    'mailto\t:',
  ];
  const quoteSplits = [
    'mail"+"to:',
    "mail'+'to:",
    'mailto" + ":',
    "mailto' + ':",
    '"mail"+"to:"',
    'mailto%22%20+%20%22:',
    'mail%22+%22to%3a',
    encodeChars('mailto"+":'),
  ];
  for (const scheme of SCHEMES) {
    carried.push(
      `${scheme}:`,
      `${scheme.toUpperCase()}:`,
      `${scheme}%3a`,
      `${scheme}%253a`,
      encodeChars(`${scheme}:`),
      encodeChars(encodeChars(`${scheme}:`)),
      encodePercentsTwice(`${scheme}:`),
    );
    quoteSplits.push(
      `${scheme}" + ":`,
      `${scheme}' + ':`,
      `${scheme.slice(0, 2)}"+"${scheme.slice(2)}:`,
    );
  }
  const omitted = /<pre id="brief">الموجز محفوظ في المشروع ولم يُعرض في الصفحة لأنه يحتوي عنواناً بعيداً\.<\/pre>/;
  for (const subtype of KINDS) {
    for (const attack of [...carried, ...quoteSplits]) {
      assert.throws(
        () => websiteDocument(attack, subtype),
        (error: unknown) => error instanceof Error && error.message === 'unsafe_path',
        `${subtype} title ${attack}`,
      );
    }
    for (const attack of carried) {
      const html = websiteDocument('صفحة', subtype, attack);
      assert.match(html, /<!doctype html>/, `${subtype} brief ${attack}`);
      assert.match(html, omitted, `${subtype} brief ${attack}`);
      assert.equal(html.includes(attack), false, `${subtype} brief ${attack}`);
      assert.equal(/(?:mailto|tel|sms|intent|market)\s*:/i.test(html), false, `${subtype} brief ${attack}`);
    }
    for (const attack of quoteSplits) {
      assert.throws(
        () => websiteDocument('صفحة', subtype, attack),
        (error: unknown) => error instanceof Error && error.message === 'unsafe_path',
        `${subtype} brief ${attack}`,
      );
    }
  }
});

function encodeChars(value: string): string {
  return [...value].map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
}

function encodePercentsTwice(value: string): string {
  return [...value].map((char) => `%25${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
}
