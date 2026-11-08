import test from 'node:test';
import assert from 'node:assert/strict';
import { BuildMenuError } from '../grants.js';
import { parseUntrustedPlan } from '../planGate.js';

const PAGES = [
  { kind: 'desktop', path: 'app/dist/index.html' },
  { kind: 'widget', path: 'app/dist/index.html' },
  { kind: 'mobile', path: 'app/simulation.html' },
  { kind: 'automation', path: 'app/preview.html' },
] as const;

const SCHEME_URLS = [
  'mailto:user@example.com',
  'tel:+97455500000',
  'sms:+97455500000',
  'intent:com.example.SCAN',
  'market:details?id=com.example.app',
  'intent://scan',
  'market://details?id=app',
] as const;

const LOCAL_ELECTRON = '<link rel="stylesheet" href="./styles.css"><script type="module" src="./app.ts"></script>';

const LOCAL_PAGE = [
  LOCAL_ELECTRON,
  '<form action="#save"></form>',
  '<button formaction="#stay">ابق</button>',
  '<iframe src="./frame.html"></iframe>',
  '<script>fetch("./notes.js");fetch(\'./notes.js\');import("./notes.js");</script>',
  '<script>fetch(`./notes.js`);import(`./app.ts`);</script>',
  '<script type="module">import note from "./notes.js";import "./app.ts";</script>',
  '<p>ملاحظة محلية: خصم 50% وابق على هذا الجهاز.</p>',
].join('');

function rejected(page: { kind: string; path: string }, content: string, message: string, label: string): void {
  assert.throws(
    () => parseUntrustedPlan({ kind: page.kind, files: [{ path: page.path, content }] }),
    (error: unknown) => error instanceof BuildMenuError && error.message === message && error.status === 400,
    label,
  );
}

function sinks(target: string): Array<{ sink: string; content: string }> {
  return [
    { sink: 'iframe', content: `<iframe src="${target}"></iframe>` },
    { sink: 'href', content: `<a href="${target}">رسالة</a>` },
    { sink: 'action', content: `<form action="${target}"></form>` },
    { sink: 'formaction', content: `<button formaction="${target}">أرسل</button>` },
    { sink: 'fetch', content: `<script>fetch("${target}")</script>` },
    { sink: 'import', content: `<script>import("${target}")</script>` },
    { sink: 'import-from', content: `<script type="module">import box from "${target}";</script>` },
    { sink: 'import-static', content: `<script type="module">import "${target}";</script>` },
    { sink: 'fetch-backtick', content: '<script>fetch(`' + target + '`)</script>' },
    { sink: 'import-backtick', content: '<script>import(`' + target + '`)</script>' },
  ];
}

function expressionSinks(expression: string): Array<{ sink: string; content: string }> {
  return [
    { sink: 'iframe', content: `<iframe src=${expression}></iframe>` },
    { sink: 'href', content: `<a href=${expression}>رسالة</a>` },
    { sink: 'action', content: `<form action=${expression}></form>` },
    { sink: 'formaction', content: `<button formaction=${expression}>أرسل</button>` },
    { sink: 'fetch', content: `<script>fetch(${expression})</script>` },
    { sink: 'import', content: `<script>import(${expression})</script>` },
    { sink: 'import-from', content: `<script type="module">import box from ${expression};</script>` },
    { sink: 'import-static', content: `<script type="module">import ${expression};</script>` },
  ];
}

function plainTargets(url: string): string[] {
  const colon = url.indexOf(':');
  const upper = url.slice(0, colon).toUpperCase() + url.slice(colon);
  const spaced = `${url.slice(0, colon)} :${url.slice(colon + 1)}`;
  return [url, upper, spaced];
}

function encoded(url: string, times: 1 | 2): string {
  let value = url;
  for (let attempt = 0; attempt < times; attempt += 1) value = encodeURIComponent(value);
  return times === 2 ? value.toLowerCase() : value;
}

test('handset schemes are refused on iframe, href, action, formaction, fetch, and import', () => {
  for (const page of PAGES) {
    for (const url of SCHEME_URLS) {
      for (const target of plainTargets(url)) {
        for (const sink of sinks(target)) {
          rejected(page, sink.content, 'unsafe_path', `${page.kind} ${sink.sink} ${target}`);
        }
      }
    }
  }
});

test('percent-encoded handset schemes are refused once and twice', () => {
  for (const page of PAGES) {
    for (const url of SCHEME_URLS) {
      for (const times of [1, 2] as const) {
        const target = encoded(url, times);
        for (const sink of sinks(target)) {
          rejected(page, sink.content, 'unsafe_path', `${page.kind} ${sink.sink} x${String(times)} ${url}`);
        }
      }
    }
  }
});

test('quote-split handset schemes are refused', () => {
  for (const page of PAGES) {
    for (const url of SCHEME_URLS) {
      const colon = url.indexOf(':');
      const scheme = url.slice(0, colon);
      const rest = url.slice(colon + 1);
      const forms = [
        `"${scheme}"+":${rest}"`,
        `'${scheme.toUpperCase()}' + ':${rest}'`,
        `"${scheme}"+"%3A${rest}"`,
        `'${scheme}' + '%253a${rest}'`,
        '`' + scheme + '`+`:' + rest + '`',
      ];
      for (const expression of forms) {
        for (const sink of expressionSinks(expression)) {
          rejected(page, sink.content, 'unsafe_path', `${page.kind} ${sink.sink} ${expression}`);
        }
      }
    }
  }
});

test('local Electron href="./styles.css" and script src="./app.ts" still parse', () => {
  for (const page of PAGES) {
    if (page.kind === 'desktop' || page.kind === 'widget') {
      const parsed = parseUntrustedPlan({ kind: page.kind, files: [{ path: page.path, content: LOCAL_ELECTRON }] });
      assert.equal(parsed.kind, page.kind);
      assert.equal(parsed.files[0]?.path, page.path);
      assert.equal(parsed.files[0]?.content, LOCAL_ELECTRON);
    }
    const local = parseUntrustedPlan({ kind: page.kind, files: [{ path: page.path, content: LOCAL_PAGE }] });
    assert.equal(local.files[0]?.content, LOCAL_PAGE, page.kind);
  }
});

test('child_process stays invalid_request', () => {
  for (const kind of ['desktop', 'widget'] as const) {
    rejected({ kind, path: 'app/dist/index.html' }, 'require("child_process")', 'invalid_request', kind);
  }
});

test('a package.json preinstall script stays rejected', () => {
  rejected(
    { kind: 'website', path: 'app/package.json' },
    '{"scripts":{"preinstall":"node evil.js"}}',
    'invalid_request',
    'package.json preinstall',
  );
});
