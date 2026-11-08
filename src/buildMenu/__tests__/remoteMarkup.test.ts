import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { desktopPreviewHtml } from '../desktop/previewPage.js';

const require = createRequire(import.meta.url);
const preview = require('../staticPreview.cjs') as { remoteMarkup: (html: string) => boolean };
const { remoteMarkup } = preview;

const LOCAL_PAGE = '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>معاينة</title><p>صفحة محلية</p><a href="./notes.html">ملاحظة</a><form action="#save"></form><button formaction="#stay">ابق</button><script src="./preview.js"></script></html>';

test('a local preview page with no remote URL passes', () => {
  assert.equal(remoteMarkup(LOCAL_PAGE), false);
  assert.equal(remoteMarkup(desktopPreviewHtml()), false);
  assert.equal(remoteMarkup('<p>رسم</p><img alt="" src="data:image/png;base64,iVBORw0KGgo=">'), false);
  assert.equal(remoteMarkup('<textarea>javascript:alert(1) https://example.test data: file: blob:</textarea><p>صفحة محلية</p>'), false);
  assert.equal(remoteMarkup('<pre>javascript:alert(1) https://example.test</pre><script>window.onerror=function(){return true;};</script>'), false);
  assert.equal(remoteMarkup('<a href="/local">هنا</a><script src="page.js"></script>'), false);
});

test('preview markup refuses data, file, and blob URLs in script src, href, and action', () => {
  const schemes = ['data:text/html,hi', 'file:///c:/secret', 'blob:null/uuid', 'https://evil.example/a.js', 'javascript:alert(1)', '//evil.example/a.js'];
  for (const url of schemes) {
    assert.equal(remoteMarkup(`<script src="${url}"></script>`), true, url);
    assert.equal(remoteMarkup(`<script src='${url}'></script>`), true, url);
    assert.equal(remoteMarkup(`<script src=${url}></script>`), true, url);
    assert.equal(remoteMarkup(`<script/src="${url}"></script>`), true, url);
    assert.equal(remoteMarkup(`<a href="${url}">x</a>`), true, url);
    assert.equal(remoteMarkup(`<a/href='${url}'>x</a>`), true, url);
    assert.equal(remoteMarkup(`<form action="${url}"></form>`), true, url);
    assert.equal(remoteMarkup(`<form/action=${url}></form>`), true, url);
    assert.equal(remoteMarkup(`<button formaction="${url}">x</button>`), true, url);
    assert.equal(remoteMarkup(`<a href="${url.replace(':', ' :')}">x</a>`), true, url);
  }
  assert.equal(remoteMarkup('<p>https://evil.example</p>'), true);
  assert.equal(remoteMarkup('<p>javascript :alert(1)</p>'), true);
  assert.equal(remoteMarkup('.href=\'file:///c:/secret\''), true);
  assert.equal(remoteMarkup('.action=data:text/plain,hi'), true);
  assert.equal(remoteMarkup('<img src="x" onerror="alert(1)">'), true);
});
