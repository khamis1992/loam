import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { desktopPreviewScript } from '../desktop/previewPage.js';

const DENIAL = 'تعذر الحفظ على هذا الجهاز. انسخ النص من المربع.';
const KEY = 'loam-desktop-note';
const TICK = String.fromCharCode(96);
const source = desktopPreviewScript();
const program = new vm.Script(source);

const LITERALS = [
  'https://example.test/a',
  'http://example.test/a',
  'HTTPS://example.test/a',
  'HTTP://example.test/a',
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'data:text/html,hi',
  'DATA:text/html,hi',
  'file:///C:/secret.txt',
  'FILE:///C:/secret.txt',
  'blob:00000000-0000-0000-0000-000000000000',
  'BLOB:00000000-0000-0000-0000-000000000000',
  'mailto:user@example.test',
  'MAILTO:user@example.test',
  'tel:+97400000000',
  'TEL:+97400000000',
  'sms:+97400000000',
  'SMS:+97400000000?body=hi',
  'intent:scan',
  'INTENT://scan',
  'market://details?id=app',
  'MARKET:details',
  '//example.test/a',
  '//HOST/a',
];

const SAFE = [
  'ملاحظة محلية',
  'ملاحظة: اليوم',
  'نص/محلي',
  'ملاحظة / محلي',
  'قل "مرحبا": اليوم',
  '1+1=2',
  'جاهز%20تمام',
  'خصم 50% اليوم',
  'https: بدون شرطتين',
  'data file mailto tel sms market intent blob',
  '   ',
];

function encodeBytes(value: string): string {
  return [...Buffer.from(value)].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');
}

function sized(prefix: string, total: number): string {
  let remain = total - Buffer.byteLength(prefix, 'utf8');
  let text = prefix;
  if (remain % 2 === 1) {
    text += 'x';
    remain -= 1;
  }
  text += 'ب'.repeat(remain / 2);
  if (Buffer.byteLength(text, 'utf8') !== total) throw new Error('size');
  return text;
}

function encodeTimes(value: string, times: number, encode: (item: string) => string): string {
  let current = value;
  for (let attempt = 0; attempt < times; attempt += 1) current = encode(current);
  return current;
}

function attacks(): string[] {
  const found = new Set<string>();
  const add = (value: string): void => { found.add(value); };
  for (const url of LITERALS) {
    add(url);
    const colonAt = url.indexOf(':');
    if (colonAt >= 0) add(`${url.slice(0, colonAt)} :${url.slice(colonAt + 1)}`);
    for (const times of [1, 2]) {
      add(encodeTimes(url, times, encodeURIComponent));
      add(encodeTimes(url, times, encodeURIComponent).toLowerCase());
      add(encodeTimes(url, times, encodeBytes));
      add(encodeTimes(url, times, encodeBytes).toUpperCase());
    }
    if (colonAt < 0) continue;
    const name = url.slice(0, colonAt);
    const rest = url.slice(colonAt + 1);
    add(`${name}'+':${rest}`);
    add(`"${name}"+":${rest}"`);
    add(`'${name}' + ':${rest}'`);
    add(`${TICK}${name}${TICK}+${TICK}:${rest}${TICK}`);
    add(`${name.slice(0, 2)}+${name.slice(2)}:${rest}`);
    add(`${name.slice(0, 2)}"${name.slice(2)}:${rest}`);
    add(`${name}%3A'+'${rest}`);
    add(`${name}%253a'+'${rest}`);
    if (rest.startsWith('//')) add(`"${name}"+"${rest}"`);
  }
  for (const name of ['https', 'http', 'HTTPS', 'HTTP']) {
    add(`${name}'+'://example.test/a`);
    add(`"${name}"+"//example.test/a"`);
    add(`"${name}"+"://example.test/a"`);
    add(`${name}%3a'+'%2f%2fexample.test/a`);
    add(`${name}%253A'+'%252F%252Fexample.test/a`);
    add(`${name.slice(0, 2)}+${name.slice(2)}://example.test/a`);
  }
  add("'/'+'/example.test/a'");
  add('"/"+"/"+"example.test/a"');
  add('/+/example.test/a');
  add(' / /example.test/a');
  add('%2f%2fexample.test/a');
  add('%252f%252fexample.test/a');
  add('%2F%2Fexample.test/a');
  add('%252F%252Fexample.test/a');
  return [...found];
}

const ATTACKS = attacks();

interface Preview {
  note: { value: string };
  error: { hidden: boolean; textContent: string };
  exported: { hidden: boolean; value: string };
  empty: { hidden: boolean };
  save: () => void;
  stored: () => string | undefined;
  writes: () => number;
}

function flush(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
}

function boot(useBridge: boolean): Preview {
  const storage = new Map<string, string>();
  const saved: string[] = [];
  let sets = 0;
  const note = {
    value: '',
    addEventListener(_type: string, fn: () => void) { save = fn; },
  };
  let save: (() => void) | undefined;
  const error = { hidden: true, textContent: '' };
  const exported = { hidden: true, value: '' };
  const empty = { hidden: true };
  const document = {
    querySelector(selector: string) {
      if (selector === '#note') return note;
      if (selector === '#save-error') return error;
      if (selector === '#export') return exported;
      if (selector === '#empty') return empty;
      return null;
    },
    addEventListener() {},
  };
  const sandbox: Record<string, unknown> = {
    document,
    Promise,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        sets += 1;
        storage.set(key, value);
      },
    },
  };
  if (useBridge) {
    sandbox.desktop = {
      loadNotes: () => Promise.resolve(''),
      saveNotes: (text: string) => {
        saved.push(text);
        return Promise.resolve(text);
      },
    };
  }
  program.runInNewContext(sandbox);
  if (!save) throw new Error('missing save');
  const write = save;
  return {
    note,
    error,
    exported,
    empty,
    save: () => { write(); },
    stored: () => (useBridge ? saved[saved.length - 1] : storage.get(KEY)),
    writes: () => (useBridge ? saved.length : sets),
  };
}

function assertDenial(preview: Preview, text: string, writes: number): void {
  assert.equal(preview.error.hidden, false, text);
  assert.equal(preview.error.textContent, DENIAL, text);
  assert.equal(preview.exported.hidden, false, text);
  assert.equal(preview.exported.value, text, text);
  assert.equal(preview.empty.hidden, true, text);
  assert.equal(preview.writes(), writes, text);
  assert.equal(preview.stored(), 'سابق', text);
}

async function exercise(useBridge: boolean): Promise<void> {
  const preview = boot(useBridge);
  preview.note.value = 'سابق';
  preview.save();
  await flush();
  assert.equal(preview.stored(), 'سابق');
  assert.equal(preview.error.hidden, true);
  assert.equal(preview.exported.hidden, true);
  const kept = preview.writes();
  assert.equal(kept, 1);
  for (const sample of ATTACKS) {
    for (const text of [sample, `قبل ${sample} بعد`]) {
      preview.note.value = text;
      preview.save();
      assertDenial(preview, text, kept);
    }
  }
  for (const text of SAFE) {
    preview.note.value = text;
    preview.save();
    await flush();
    assert.equal(preview.error.hidden, true, text);
    assert.equal(preview.exported.hidden, true, text);
    assert.equal(preview.empty.hidden, text.trim().length > 0, text);
    assert.equal(preview.stored(), text, text);
  }
}

test('the desktop preview script source stays local', () => {
  assert.equal(/https?:\/\//i.test(source), false);
  assert.equal(/javascript\s*:/i.test(source), false);
  assert.equal(/(?<!:)\/\//.test(source), false);
  assert.equal(source.includes('</script'), false);
  assert.ok(ATTACKS.length > 40);
});

test('localStorage refuses schemes and still saves plain Arabic', async () => {
  await exercise(false);
});

test('desktop.saveNotes refuses schemes and still saves plain Arabic', async () => {
  await exercise(true);
});

test('65536 bytes save and 65537 bytes show the denial', async () => {
  const exact = 'ا'.repeat(32768);
  assert.equal(Buffer.byteLength(exact, 'utf8'), 65536);
  const over = `${exact}x`;
  assert.equal(Buffer.byteLength(over, 'utf8'), 65537);
  const remoteOver = sized('https://example.test/', 65537);
  for (const useBridge of [false, true]) {
    const preview = boot(useBridge);
    preview.note.value = exact;
    preview.save();
    await flush();
    assert.equal(preview.error.hidden, true, String(useBridge));
    assert.equal(preview.exported.hidden, true, String(useBridge));
    assert.equal(preview.stored(), exact, String(useBridge));
    assert.equal(preview.writes(), 1, String(useBridge));
    preview.note.value = over;
    preview.save();
    assertDenialSize(preview, over);
    preview.note.value = remoteOver;
    preview.save();
    assertDenialSize(preview, remoteOver);
    preview.note.value = 'ملاحظة';
    preview.save();
    await flush();
    assert.equal(preview.error.hidden, true, String(useBridge));
    assert.equal(preview.stored(), 'ملاحظة', String(useBridge));
  }
});

function assertDenialSize(preview: Preview, text: string): void {
  assert.equal(preview.error.hidden, false);
  assert.equal(preview.error.textContent, DENIAL);
  assert.equal(preview.exported.hidden, false);
  assert.equal(preview.exported.value, text);
  assert.equal(preview.empty.hidden, true);
  assert.equal(preview.writes(), 1);
  assert.equal(Buffer.byteLength(preview.stored() ?? '', 'utf8'), 65536);
}
