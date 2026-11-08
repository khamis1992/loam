import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExtensionManifest } from '../chrome/permissions.js';
import { chromeManualLoad } from '../chrome/manualLoad.js';
import { assertLocalExtension, extensionFiles, popupScript, unsafeExtensionPage, unsafeExtensionScript } from '../extensions/source.js';

const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extensions', 'source.ts');

const SCHEMES = [
  'mailto:a@b.c',
  'tel:+15551212',
  'sms:+15551212',
  'intent:scan/#Intent;end',
  'market:details?id=app',
];

function page(inner: string): string {
  return `<!doctype html>${inner}<script src="popup.js"></script>`;
}

function encodeTimes(value: string, times: number): string {
  let current = value;
  for (let attempt = 0; attempt < times; attempt += 1) {
    current = Array.from(current, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
  }
  return current;
}

function targets(url: string): string[] {
  return [
    url,
    url.toUpperCase(),
    url.replace(':', '%3A'),
    url.replace(':', '%3a'),
    url.replace(':', '%253A'),
    url.replace(':', '%253a'),
    encodeTimes(url, 1),
    encodeTimes(url, 2),
    url.replace(':', ' :'),
  ];
}

function snippets(value: string): string[] {
  const quoted = [
    `<a href="${value}">x</a>`,
    `<a href='${value}'>x</a>`,
    `<a/href="${value}">x</a>`,
    `<form action="${value}"></form>`,
    `<form action='${value}'></form>`,
    `<form/action="${value}"></form>`,
    `<button formaction="${value}">x</button>`,
    `<button formaction='${value}'>x</button>`,
    `<button/formaction="${value}">x</button>`,
  ];
  if (/\s/.test(value)) return quoted;
  return [
    ...quoted,
    `<a href=${value}>x</a>`,
    `<form action=${value}></form>`,
    `<button formaction=${value}></button>`,
  ];
}

function popup(): string {
  return extensionFiles('ملاحظة').find((file) => file.path === 'popup.html')?.content ?? '';
}

function manifest(): Record<string, unknown> {
  const file = extensionFiles('ملاحظة').find((entry) => entry.path === 'manifest.json');
  return JSON.parse(file?.content ?? '{}') as Record<string, unknown>;
}

test('a tag-scoped event handler ignores escaped onerror text and the popup keeps a split url', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.equal(source.includes('/<[^>]*\\son[a-z]+\\s*=/i'), true);
  assert.equal(/<[^>]*\son[a-z]+\s*=/i.test('<p>say " onerror="alert(1)"</p>'), false);
  assert.equal(/<[^>]*\son[a-z]+\s*=/i.test('<img src="x" onerror="alert(1)">'), true);
  assert.equal(unsafeExtensionPage(page('<p>say " onerror="alert(1)"</p>')), false);
  assert.equal(unsafeExtensionPage(page('<img src="x" onerror="alert(1)">')), true);

  const named = extensionFiles('say " onerror=" <a href="mailto:a@b.c">');
  const namedPopup = named.find((file) => file.path === 'popup.html')?.content ?? '';
  assert.match(namedPopup, /&quot; onerror=&quot;/);
  assert.match(namedPopup, /mailto:/);
  assert.equal(/<[^>]*\son[a-z]+\s*=/i.test(namedPopup), false);
  assert.equal(unsafeExtensionPage(namedPopup), false);
  assertLocalExtension(named);

  const hidden = extensionFiles('ملاحظة', 'mailto:a@b.c');
  const hiddenPopup = hidden.find((file) => file.path === 'popup.html')?.content ?? '';
  assert.match(hiddenPopup, /لم يُعرض في الصفحة/);
  assert.equal(hiddenPopup.includes('mailto:'), false);
  assert.equal(unsafeExtensionPage(hiddenPopup), false);
  assertLocalExtension(hidden);

  const script = popupScript();
  assert.match(script, /startsWith\('http' \+ ':\/\/'\)/);
  assert.match(script, /startsWith\('https' \+ ':\/\/'\)/);
  assert.equal(/https?:\/\//.test(script), false);
  assert.equal(unsafeExtensionScript(script), false);
  assert.equal(unsafeExtensionPage(popup()), false);
  assertLocalExtension(extensionFiles('ملاحظة'));
});

test('extension html refuses mailto, tel, sms, intent, and market links including percent encoding', () => {
  for (const url of SCHEMES) {
    for (const value of targets(url)) {
      for (const snippet of snippets(value)) {
        assert.equal(unsafeExtensionPage(page(snippet)), true, snippet);
      }
    }
  }
  assert.equal(unsafeExtensionPage(page('<a\nhref="mailto:a@b.c">x</a>')), true);
  assert.equal(unsafeExtensionPage(page('<form action=" tel%253A1555"></form>')), true);
  assert.equal(unsafeExtensionPage(page('<button formaction=" %73%6D%73%3A1555">x</button>')), true);
  assert.throws(
    () => assertLocalExtension([{ path: 'popup.html', content: page('<a href="mailto:a@b.c">x</a>') }]),
    /unsafe_path/,
  );

  const local = [
    '<a href="popup.html">p</a>',
    '<a href="a.html">a</a>',
    '<a href="./a.html">r</a>',
    '<a href="mailto.html">m</a>',
    '<a href="tel.html">t</a>',
    '<a href="sms.html">s</a>',
    '<a href="intent.html">i</a>',
    '<a href="market.html">k</a>',
    '<form action="popup.html"></form>',
    '<form action="#save"></form>',
    '<button formaction="a.html">x</button>',
    '<button formaction="#stay">x</button>',
    '<p>say " onerror="alert(1)" href="mailto:a@b.c"</p>',
    '<p>&lt;a href="mailto:a@b.c"&gt;</p>',
  ].join('');
  assert.equal(unsafeExtensionPage(page(local)), false);
  assertLocalExtension([{ path: 'popup.html', content: page(local) }]);
});

test('local popup matches stay accepted and host rights stay refused without claiming a load', () => {
  const generated = manifest();
  assertExtensionManifest(generated);
  assertExtensionManifest({
    ...generated,
    content_scripts: [{ matches: ['popup.html', 'a.html'], js: ['popup.js'] }],
  });
  assertExtensionManifest({
    ...generated,
    content_scripts: [{
      matches: ['a.html'],
      js: ['popup.js'],
      world: 'ISOLATED',
      match_about_blank: false,
      match_origin_as_fallback: false,
    }],
  });
  assert.throws(
    () => assertExtensionManifest({ ...generated, host_permissions: ['https://example.test/*'] }),
    /host_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({ ...generated, host_permissions: ['<all_urls>'] }),
    /host_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({ ...generated, permissions: ['<all_urls>'] }),
    /permission_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({ ...generated, externally_connectable: { matches: ['https://example.test/*'] } }),
    /permission_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({ ...generated, externally_connectable: { matches: ['popup.html'] } }),
    /permission_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({
      ...generated,
      content_scripts: [{ matches: ['a.html', 'popup.html'], js: ['popup.js'], world: 'MAIN' }],
    }),
    /permission_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({
      ...generated,
      content_scripts: [{ matches: ['popup.html'], js: ['popup.js'], match_about_blank: true }],
    }),
    /permission_requires_review/,
  );
  assert.throws(
    () => assertExtensionManifest({
      ...generated,
      content_scripts: [{ matches: ['a.html'], js: ['popup.js'], match_origin_as_fallback: true }],
    }),
    /permission_requires_review/,
  );

  const handoff = chromeManualLoad();
  assert.equal(handoff.extensionLoaded, false);
  assert.equal(handoff.browserTestRan, false);
  const joined = extensionFiles('ملاحظة').map((file) => file.content).join('\n');
  assert.equal(/extension was loaded|loaded the extension|extension loaded|extensionLoaded/i.test(joined), false);
  assert.equal(/extension was loaded|loaded the extension|extension loaded/i.test(handoff.lines.join('\n')), false);
});
