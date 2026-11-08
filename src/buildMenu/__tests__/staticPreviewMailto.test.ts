import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { desktopPreviewHtml } from '../desktop/previewPage.js';

const require = createRequire(import.meta.url);
const preview = require('../staticPreview.cjs') as { remoteMarkup: (html: string) => boolean };
const { remoteMarkup } = preview;

const LOCAL_PAGE = '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\'; img-src \'self\' data:"><title>معاينة</title><p>رسم</p><img alt="" src="data:image/png;base64,iVBORw0KGgo="><a href="./notes.html">ملاحظة</a><form action="#save"></form><button formaction="#stay">ابق</button><script src="./preview.js"></script></html>';

test('an image data URL, a CSP data token, and local preview targets still pass', () => {
  assert.equal(remoteMarkup(LOCAL_PAGE), false);
  assert.equal(remoteMarkup(desktopPreviewHtml()), false);
  assert.equal(remoteMarkup('<p>رسم</p><img alt="" src="data:image/png;base64,iVBORw0KGgo=">'), false);
  assert.equal(remoteMarkup('<meta http-equiv="Content-Security-Policy" content="img-src \'self\' data:">'), false);
  assert.equal(remoteMarkup('<script src="./preview.js"></script>'), false);
  assert.equal(remoteMarkup('<form action="#save"></form>'), false);
  assert.equal(remoteMarkup('<textarea>mailto:a@b.c tel:+1 sms:+1 intent:#Intent;end market://details</textarea><p>صفحة محلية</p>'), false);
  assert.equal(remoteMarkup('<pre>mailto%3Aa@b.c %6d%61%69%6c%74%6f%3Aa@b.c</pre><script src="./preview.js"></script>'), false);
  assert.equal(remoteMarkup('<a href="/local">هنا</a><script src="page.js"></script>'), false);
});

test('preview markup refuses mailto, tel, sms, intent, and market URLs', () => {
  const schemes = [
    'mailto:user@example.com',
    'MaIlTo:user@example.com',
    'MAILTO:user@example.com',
    'tel:+97400000000',
    'TEL:+97400000000',
    'sms:+97400000000?body=hi',
    'intent:#Intent;end',
    'market://details?id=com.example.app',
  ];
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
  assert.equal(remoteMarkup('.href=\'mailto:user@example.com\''), true);
  assert.equal(remoteMarkup('.action=tel:+97400000000'), true);
});

test('preview markup refuses mailto, tel, sms, intent, and market percent-encoded once or twice', () => {
  const encoded = [
    'mailto%3Auser%40example.com',
    'TEL%3A%2B97400000000',
    'sms%3A%2B97400000000',
    'intent%3A%23Intent%3Bend',
    'Market%3A%2F%2Fdetails%3Fid%3Dcom.example.app',
    'mailto%253Auser%2540example.com',
    'tel%253A%252B97400000000',
    'sms%253A%252B97400000000',
    'intent%253A%2523Intent%253Bend',
    'market%253A%252F%252Fdetails',
    '%6d%61%69%6c%74%6f%3auser%40example.com',
    '%256d%2561%2569%256c%2574%256f%253auser%2540example.com',
    'Sms%253A123',
  ];
  for (const url of encoded) {
    assert.equal(remoteMarkup(`<script src="${url}"></script>`), true, url);
    assert.equal(remoteMarkup(`<script src='${url}'></script>`), true, url);
    assert.equal(remoteMarkup(`<script src=${url}></script>`), true, url);
    assert.equal(remoteMarkup(`<script/src="${url}"></script>`), true, url);
    assert.equal(remoteMarkup(`<a href="${url}">x</a>`), true, url);
    assert.equal(remoteMarkup(`<a/href='${url}'>x</a>`), true, url);
    assert.equal(remoteMarkup(`<form action="${url}"></form>`), true, url);
    assert.equal(remoteMarkup(`<form/action=${url}></form>`), true, url);
    assert.equal(remoteMarkup(`<button formaction="${url}">x</button>`), true, url);
    assert.equal(remoteMarkup(`.href='${url}'`), true, url);
    assert.equal(remoteMarkup(`.action=${url}`), true, url);
  }
});
