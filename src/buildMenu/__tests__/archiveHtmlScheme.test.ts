import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractZip } from '../../preview/zip.js';
import { resolveArtifact, sourceEntries, writeSourceArtifact } from '../artifacts.js';

const LOCAL_PAGE = [
  '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8">',
  '<title>معاينة</title><p>صفحة محلية</p>',
  '<script src="./preview.js"></script>',
  '<form action="#save"></form>',
  '<a href="./notes.html">ملاحظة</a>',
  '<a href="mailto.html">m</a>',
  '<a href="tel.html">t</a>',
  '<button formaction="#stay">ابق</button>',
  '<p>mailto:user@example.com tel:+1 sms:+1 intent:#Intent;end market://details https://example.com data:text file: blob:</p>',
  '<pre>mailto%3Auser %6d%61%69%6c%74%6f%3Auser</pre>',
  '</html>',
].join('');

const WEB = [
  'javascript:alert(1)',
  'https://evil.example/a.js',
  'http://evil.example/a.js',
  'data:text/html,hi',
  'file:///c:/notes.txt',
  'blob:null/uuid',
  '//evil.example/a.js',
];

const HANDSET = [
  'mailto:user@example.com',
  'tel:+97400000000',
  'sms:+97400000000?body=hi',
  'intent:#Intent;end',
  'market://details?id=com.example.app',
];

function unsafe(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
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

function webSnippets(value: string): string[] {
  const snippets = [
    `<script src="${value}"></script>`,
    `<script src='${value}'></script>`,
    `<script/src="${value}"></script>`,
    `<img alt="" src="${value}">`,
    `<a href="${value}">x</a>`,
    `<a href='${value}'>x</a>`,
    `<a/href="${value}">x</a>`,
    `<form action="${value}"></form>`,
    `<form action='${value}'></form>`,
    `<form/action="${value}"></form>`,
    `<button formaction="${value}">x</button>`,
  ];
  if (/\s/.test(value)) return snippets;
  return [
    ...snippets,
    `<script src=${value}></script>`,
    `<img alt="" src=${value}>`,
    `<a href=${value}>x</a>`,
    `<form action=${value}></form>`,
  ];
}

function handsetSnippets(value: string): string[] {
  const snippets = [
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
  if (/\s/.test(value)) return snippets;
  return [
    ...snippets,
    `<a href=${value}>x</a>`,
    `<form action=${value}></form>`,
    `<button formaction=${value}></button>`,
  ];
}

function assertRefused(root: string, html: string): void {
  const app = path.join(root, 'app');
  const page = path.join(app, 'index.html');
  const dest = path.join(root, '.loam', 'build-menu', 'artifacts');
  const partial = path.join(dest, 'partial.zip');
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(page, html);
  fs.writeFileSync(path.join(app, 'preview.js'), 'local\n');
  fs.writeFileSync(path.join(app, 'keep.txt'), 'kept');
  fs.writeFileSync(partial, 'not-a-real-zip');
  assert.throws(() => sourceEntries(app), unsafe, html);
  assert.throws(
    () => writeSourceArtifact(root, 'app_abcdefghijkl', 1, 'source-zip'),
    unsafe,
    html,
  );
  assert.deepEqual(fs.readdirSync(dest).sort(), ['partial.zip']);
  assert.equal(fs.readFileSync(partial, 'utf8'), 'not-a-real-zip');
  assert.equal(fs.existsSync(`${partial}.tmp`), false);
  assert.equal(fs.existsSync(path.join(root, 'app.zip')), false);
  assert.equal(fs.readFileSync(page, 'utf8'), html);
  assert.equal(fs.readFileSync(path.join(app, 'preview.js'), 'utf8'), 'local\n');
  assert.equal(fs.readFileSync(path.join(app, 'keep.txt'), 'utf8'), 'kept');
}

test('local src and save action still pack', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-archive-html-'));
  const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-archive-html-unpack-'));
  const app = path.join(root, 'app');
  const extra = '<script src="./preview%2Ejs"></script><form action="%23save"></form>';
  try {
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, 'index.html'), LOCAL_PAGE);
    fs.writeFileSync(path.join(app, 'extra.html'), extra);
    fs.writeFileSync(path.join(app, 'preview.js'), 'local\n');
    const entries = sourceEntries(app);
    assert.deepEqual(entries.map((entry) => entry.name).sort(), ['extra.html', 'index.html', 'preview.js']);
    assert.equal(entries.find((entry) => entry.name === 'index.html')?.data.toString('utf8'), LOCAL_PAGE);
    assert.equal(LOCAL_PAGE.includes('src="./preview.js"'), true);
    assert.equal(LOCAL_PAGE.includes('action="#save"'), true);
    const artifact = writeSourceArtifact(root, 'app_abcdefghijkl', 1, 'source-zip');
    const loaded = resolveArtifact(root, 'app_abcdefghijkl', artifact.artifactId);
    assert.equal(loaded.bytes.subarray(0, 2).toString('utf8'), 'PK');
    assert.deepEqual(extractZip(loaded.bytes, unpacked).sort(), ['extra.html', 'index.html', 'preview.js']);
    assert.equal(fs.readFileSync(path.join(unpacked, 'index.html'), 'utf8'), LOCAL_PAGE);
    assert.equal(fs.readFileSync(path.join(unpacked, 'preview.js'), 'utf8'), 'local\n');
    assert.equal(fs.readFileSync(path.join(app, 'index.html'), 'utf8'), LOCAL_PAGE);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(unpacked, { recursive: true, force: true });
  }
});

test('source html refuses javascript, https, data, file, and blob on src, href, and action and writes no zip', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-archive-html-web-'));
  try {
    for (const url of WEB) {
      for (const value of targets(url)) {
        for (const snippet of webSnippets(value)) {
          assertRefused(root, `<!doctype html>${snippet}`);
        }
      }
    }
    assertRefused(root, '<a\nhref="https://evil.example/a.js">x</a>');
    assertRefused(root, '<form\naction="javascript:alert(1)"></form>');
    assertRefused(root, '<img\nsrc="data:text/html,hi">');
    const nested = path.join(root, 'app', 'notes');
    fs.mkdirSync(nested, { recursive: true });
    const page = path.join(nested, 'page.html');
    fs.writeFileSync(page, '<script src="https://evil.example/a.js"></script>');
    assert.throws(() => sourceEntries(path.join(root, 'app')), unsafe);
    assert.equal(fs.readFileSync(page, 'utf8'), '<script src="https://evil.example/a.js"></script>');
    assert.deepEqual(fs.readdirSync(path.join(root, '.loam', 'build-menu', 'artifacts')).sort(), ['partial.zip']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source html refuses mailto, tel, sms, intent, and market on href, action, and formaction including percent-encoding and writes no zip', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-archive-html-handset-'));
  try {
    for (const url of HANDSET) {
      for (const value of targets(url)) {
        for (const snippet of handsetSnippets(value)) {
          assertRefused(root, `<!doctype html>${snippet}`);
        }
      }
    }
    assertRefused(root, '<a\nhref="mailto:user@example.com">x</a>');
    assertRefused(root, '<form action=" tel%253A1555"></form>');
    assertRefused(root, '<button formaction=" %73%6D%73%3A1555">x</button>');
    assertRefused(root, '<a href="%20mailto%3Auser@example.com">x</a>');
    assertRefused(root, '<button formaction="%256d%2561%2569%256c%2574%256f%253Auser@example.com">x</button>');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
