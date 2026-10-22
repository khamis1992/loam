import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dataSectionRange,
  rebrandDist,
  rebrandHtml,
  rebrandWasm,
  replaceAllBytes,
} from '../rebrand.mjs';

const bytes = (arr) => Buffer.from(arr);
const ascii = (s) => Buffer.from(s, 'latin1');

function uleb(n) {
  const out = [];
  let x = n;
  do {
    let b = x & 0x7f;
    x >>>= 7;
    if (x > 0) b |= 0x80;
    out.push(b);
  } while (x > 0);
  return bytes(out);
}

/** Build a tiny synthetic wasm module: magic + optional sections + data section. */
function wasmModule({ dataPayload, extraSections = [] }) {
  const parts = [bytes([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])];
  for (const section of extraSections) parts.push(section);
  parts.push(Buffer.concat([ascii([0x0b]), uleb(dataPayload.length), dataPayload]));
  return Buffer.concat(parts);
}

function customSection(content) {
  return Buffer.concat([ascii([0x00]), uleb(content.length), content]);
}

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'effectcraft-rebrand-'));
}

test('dataSectionRange rejects a non-wasm buffer', () => {
  assert.throws(() => dataSectionRange(ascii('not wasm')), /bad magic/);
});

test('dataSectionRange rejects a wasm module without a data section', () => {
  const module = Buffer.concat([
    bytes([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    customSection(ascii('hello')),
  ]);
  assert.throws(() => dataSectionRange(module), /no data section/);
});

test('replaceAllBytes patches same-length strings inside the data section only', () => {
  const module = wasmModule({ dataPayload: bytes([0x01, ...ascii('EffectCraft')]) });
  const { patched } = replaceAllBytes(module, 'EffectCraft', 'Loam Effect');
  assert.equal(patched, 1);
  assert.ok(module.includes(ascii('Loam Effect')));
  assert.ok(!module.includes(ascii('EffectCraft')));
});

test('replaceAllBytes refuses to patch a hit outside the data section', () => {
  const module = wasmModule({
    extraSections: [customSection(ascii('EffectCraft'))],
    dataPayload: bytes([0x01, ...ascii('EffectCraft')]),
  });
  assert.throws(
    () => replaceAllBytes(module, 'EffectCraft', 'Loam Effect'),
    /outside the data section/,
  );
  assert.ok(module.includes(ascii('EffectCraft')));
});

test('rebrandHtml renames the title and applies the catch-all', () => {
  const out = rebrandHtml('<title>EffectCraft</title><p>Loading EffectCraft…</p>');
  assert.ok(out.includes('<title>Loam Effects</title>'));
  assert.ok(out.includes('Loading Loam Effects…'));
  assert.ok(!out.includes('EffectCraft'));
});

test('rebrandDist rebrands html and wasm, then is idempotent', () => {
  const dir = makeTempDir();
  try {
    const htmlPath = join(dir, 'index.html');
    const wasmPath = join(dir, 'effectcraft_web_bg.wasm');
    writeFileSync(htmlPath, '<title>EffectCraft</title><p>Loading EffectCraft…</p>', 'utf8');
    writeFileSync(wasmPath, wasmModule({ dataPayload: bytes([0x01, ...ascii('EffectCraft')]) }));

    const first = rebrandDist(dir);
    assert.equal(first.changed, true);
    assert.equal(first.htmlChanged, true);
    assert.equal(first.wasmChanged, true);
    assert.ok(first.patched >= 1);
    assert.ok(readFileSync(htmlPath, 'utf8').includes('<title>Loam Effects</title>'));
    const wasm = readFileSync(wasmPath);
    assert.ok(wasm.includes(ascii('Loam Effect')));
    assert.ok(!wasm.includes(ascii('EffectCraft')));

    const second = rebrandDist(dir);
    assert.equal(second.changed, false);
    assert.equal(second.htmlChanged, false);
    assert.equal(second.wasmChanged, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rebrandDist refuses and leaves files untouched when a wasm hit is outside the data section', () => {
  const dir = makeTempDir();
  try {
    const htmlPath = join(dir, 'index.html');
    const wasmPath = join(dir, 'effectcraft_web_bg.wasm');
    const originalHtml = '<title>EffectCraft</title>';
    writeFileSync(htmlPath, originalHtml, 'utf8');
    const wasm = wasmModule({
      extraSections: [customSection(ascii('EffectCraft'))],
      dataPayload: bytes([0x01, ...ascii('EffectCraft')]),
    });
    writeFileSync(wasmPath, wasm);

    assert.throws(() => rebrandDist(dir), /outside the data section/);
    assert.equal(readFileSync(htmlPath, 'utf8'), originalHtml);
    assert.deepEqual(readFileSync(wasmPath), wasm);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rebrandWasm applies both EffectCraft and ArtCraft replacements', () => {
  const module = wasmModule({
    dataPayload: bytes([0x01, ...ascii('EffectCraft ArtCraft')]),
  });
  const patched = rebrandWasm(module);
  assert.equal(patched, 2);
  assert.ok(module.includes(ascii('Loam Effect')));
  assert.ok(module.includes(ascii('LoamFilm')));
});
