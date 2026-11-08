import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionFiles } from '../extensions/source.js';
import { safariLabel } from '../safari/label.js';
import { safariPreviewHtml } from '../safari/platform.js';

const NOTE = 'تصدير المصدر على هذا الجهاز مكتمل. لم يُختبر Safari نفسه.';

function localPreview(): string {
  const popup = extensionFiles('ملاحظة').find((file) => file.path === 'popup.html')?.content;
  assert.ok(popup);
  return safariPreviewHtml(popup);
}

function refuses(html: string): void {
  assert.throws(
    () => safariPreviewHtml(html),
    (error: unknown) => error instanceof Error && error.message === 'unsafe_path',
    html,
  );
}

test('a local popup keeps the capture button and the untested Safari note', () => {
  const page = localPreview();
  assert.match(page, /<button id="capture"/);
  assert.equal(page.includes(`<p id="safari-untested">${NOTE}</p>`), true);
  assert.match(page, /<script src="popup\.js"><\/script>/);
  assert.equal(safariPreviewHtml(page), page);

  const anchored = `<!doctype html><p id="safari-untested">${NOTE}</p><a href="./notes.html">ملاحظة</a><form action="#save"></form><button id="capture" type="button" formaction="#stay">احفظ النص المحدد</button><script src="popup.js"></script>`;
  assert.equal(safariPreviewHtml(anchored), anchored);
});

test('safari preview refuses data, file, and blob urls on script src, href, action, and formaction', () => {
  const page = localPreview();
  const schemes = ['data:text/html,hi', 'file:///c:/secret', 'blob:null/uuid', 'DATA:text/html,hi', 'File:///C:/secret', 'BLOB:null/uuid'];
  for (const url of schemes) {
    const spaced = url.replace(':', ' :');
    for (const snippet of [
      `<script src="${url}"></script>`,
      `<script src='${url}'></script>`,
      `<script src=${url}></script>`,
      `<script/src="${url}"></script>`,
      `<a href="${url}">x</a>`,
      `<a href='${url}'>x</a>`,
      `<a href=${url}>x</a>`,
      `<a/href="${url}">x</a>`,
      `<a href="${spaced}">x</a>`,
      `<form action="${url}"></form>`,
      `<form action='${url}'></form>`,
      `<form action=${url}></form>`,
      `<form/action="${url}"></form>`,
      `<button formaction="${url}">x</button>`,
      `<button formaction='${url}'>x</button>`,
      `<button formaction=${url}></button>`,
      `<button/formaction="${url}">x</button>`,
      `.href='${url}'`,
      `.action=${url}`,
    ]) {
      refuses(`${page}${snippet}`);
    }
  }
});

test('safari preview refuses percent-encoded javascript urls', () => {
  const page = localPreview();
  for (const snippet of [
    '<a href="javascript%3Aalert(1)">x</a>',
    '<a href="JavaScript%3Aalert(1)">x</a>',
    '<form action="javascript%3Aalert(1)"></form>',
    '<button formaction="javascript%3Aalert(1)">x</button>',
    '<script src="javascript%3Aalert(1)"></script>',
    'javascript%3Aalert(1)',
  ]) {
    refuses(`${page}${snippet}`);
  }
  assert.equal(page.includes(NOTE), true);
});

test('win32 still rejects a caller that claims Safari or Xcode ran', () => {
  assert.throws(() => safariLabel({ platform: 'win32', xcodeRan: true }), /invalid_request/);
  assert.throws(() => safariLabel({ platform: 'win32', safariTested: true }), /invalid_request/);
  assert.throws(() => safariLabel({ platform: 'win32', xcodeRan: true, safariTested: true }), /invalid_request/);
  if (process.platform === 'win32') {
    assert.throws(() => safariLabel({ xcodeRan: true }), /invalid_request/);
    assert.throws(() => safariLabel({ safariTested: true }), /invalid_request/);
  }
  const honest = safariLabel({ platform: 'win32', xcodeRan: false, safariTested: false });
  assert.equal(honest.safariTested, false);
  assert.equal(honest.xcodeRan, false);
});
