import test from 'node:test';
import assert from 'node:assert/strict';
import { unsafeWebsitePreview } from '../websites/bundle.js';

const LOCAL_PAGE = '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>معاينة</title><p>صفحة محلية</p><a href="#notes">ملاحظة</a><form action="#save"></form><button formaction="#stay">ابق</button><script>document.title="محلي"</script></html>';

const REMOTE = [
  'data:text/html,hi',
  'file:///c:/secret',
  'blob:null/uuid',
  'https://evil.example/a.js',
  'javascript:alert(1)',
  '//evil.example/a.js',
];

test('unsafeWebsitePreview refuses https, javascript, and remote src, href, action, and formaction', () => {
  assert.equal(unsafeWebsitePreview('<p>https://evil.example</p>'), true);
  assert.equal(unsafeWebsitePreview('<p>javascript:alert(1)</p>'), true);
  for (const url of REMOTE) {
    assert.equal(unsafeWebsitePreview(` src="${url}"`), true, `src ${url}`);
    assert.equal(unsafeWebsitePreview(` href="${url}"`), true, `href ${url}`);
    assert.equal(unsafeWebsitePreview(` action="${url}"`), true, `action ${url}`);
    assert.equal(unsafeWebsitePreview(` formaction="${url}"`), true, `formaction ${url}`);
    assert.equal(unsafeWebsitePreview(`<img src="${url}">`), true, `img src ${url}`);
    assert.equal(unsafeWebsitePreview(`<a href='${url}'>x</a>`), true, `href quotes ${url}`);
    assert.equal(unsafeWebsitePreview(`<form action=${url}></form>`), true, `bare action ${url}`);
    assert.equal(unsafeWebsitePreview(`<button formaction="${url}">x</button>`), true, `button formaction ${url}`);
    assert.equal(unsafeWebsitePreview(`<img formaction='${url}'>`), true, `img formaction ${url}`);
    assert.equal(unsafeWebsitePreview(`<img formaction=${url}>`), true, `bare formaction ${url}`);
  }
});

test('a local page with one inline script and no remote URL passes', () => {
  assert.equal((LOCAL_PAGE.match(/<script\b/gi) ?? []).length, 1);
  assert.equal(/https?:\/\//i.test(LOCAL_PAGE), false);
  assert.equal(/javascript:/i.test(LOCAL_PAGE), false);
  assert.equal(unsafeWebsitePreview(LOCAL_PAGE), false);
});
