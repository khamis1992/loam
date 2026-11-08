import assert from 'node:assert/strict';
import test from 'node:test';
import { pageBriefText, visibleBriefHtml } from '../briefHtml.js';

const OMITTED = 'الموجز محفوظ في المشروع ولم يُعرض في الصفحة لأنه يحتوي عنواناً بعيداً.';
const HIDDEN = `<pre id="brief">${OMITTED}</pre>`;

function encodeOnce(value: string): string {
  return Array.from(value, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
}

function staysInProject(brief: string): void {
  const html = visibleBriefHtml(brief);
  assert.equal(html, HIDDEN, brief);
  assert.equal(pageBriefText(brief), OMITTED, brief);
  assert.equal(html.includes(brief.trim()), false, brief);
}

test('a safe local brief is HTML-escaped', () => {
  assert.equal(pageBriefText('  A & B < C > D "E"  '), 'A & B < C > D "E"');
  assert.equal(visibleBriefHtml('  A & B < C > D "E"  '), '<pre id="brief">A &amp; B &lt; C &gt; D &quot;E&quot;</pre>');
  assert.equal(visibleBriefHtml('hotel: downtown and supermarket: open'), '<pre id="brief">hotel: downtown and supermarket: open</pre>');
  assert.equal(visibleBriefHtml('note 100% done'), '<pre id="brief">note 100% done</pre>');
});

test('an empty brief adds nothing', () => {
  assert.equal(pageBriefText(''), '');
  assert.equal(pageBriefText(' \n\t '), '');
  assert.equal(visibleBriefHtml(''), '');
  assert.equal(visibleBriefHtml(' \n\t '), '');
});

test('a brief containing https, javascript, data, file, blob, or a protocol-relative URL is not copied into the page', () => {
  const cases = [
    ['راجع https://example.test قبل البناء', 'https'],
    ['HTTP://example.test/a', 'http'],
    ['javascript:alert(1)', 'javascript'],
    ['JavaScript :alert(1)', 'javascript'],
    ['data:text/html,hi', 'data:'],
    ['DATA :text/plain,x', 'data:'],
    ['file:///c:/secret', 'file:'],
    ['blob:null/uuid', 'blob:'],
    ['انظر //cdn.example/a.js', '//'],
  ] as const;
  for (const [brief, scheme] of cases) {
    const html = visibleBriefHtml(brief);
    assert.equal(html, HIDDEN, brief);
    assert.equal(pageBriefText(brief), OMITTED, brief);
    assert.equal(html.toLowerCase().includes(scheme), false, brief);
    assert.equal(html.includes('example.test'), false, brief);
    assert.equal(html.includes('cdn.example'), false, brief);
    assert.equal(html.includes('alert(1)'), false, brief);
  }
});

test('mailto, tel, sms, intent, and market stay in the project file, including percent-encoding', () => {
  const schemes = ['mailto', 'tel', 'sms', 'intent', 'market'] as const;
  for (const scheme of schemes) {
    const upper = scheme.toUpperCase();
    const mixed = `${scheme.slice(0, 1).toUpperCase()}${scheme.slice(1)}`;
    const literal = `${scheme}:user@example.test`;
    const briefs = [
      literal,
      `${upper}:user@example.test`,
      `${mixed} :user@example.test`,
      `  ${scheme}:user@example.test  `,
      `${scheme}%3auser@example.test`,
      `${upper}%3Auser@example.test`,
      `${scheme}%253auser@example.test`,
      `${mixed}%253Auser@example.test`,
      `قبل ${scheme}%253auser@example.test بعد`,
      `${scheme}:<script>alert(1)</script>`,
      encodeURIComponent(literal),
      encodeURIComponent(encodeURIComponent(literal)),
      encodeOnce(`${scheme}:user@example.test`),
      encodeOnce(`${scheme}:user@example.test`).toUpperCase(),
      encodeOnce(encodeOnce(`${scheme}:user@example.test`)),
    ];
    for (const brief of briefs) {
      const html = visibleBriefHtml(brief);
      assert.equal(html, HIDDEN, brief);
      assert.equal(pageBriefText(brief), OMITTED, brief);
      assert.equal(html.toLowerCase().includes(scheme), false, brief);
      assert.equal(html.toLowerCase().includes(`${scheme}:`), false, brief);
      assert.equal(/%3a/i.test(html), false, brief);
      assert.equal(html.includes('example.test'), false, brief);
      assert.equal(html.includes('<script>'), false, brief);
    }
  }
  staysInProject('mailto%3Auser@example.test');
});
