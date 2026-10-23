import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildZip, extractZip } from '../lib/zip.mjs';
import { runEffectcraftFetch } from '../fetch-effectcraft.mjs';
import { runFilmcraftFetch } from '../fetch-filmcraft.mjs';
import { sha256Hex } from '../lib/vendor.mjs';

const FIXTURE_ROOT = 'filmcraft-web-0.10.0';

/** Minimal valid wasm module whose data section carries `text`. */
function makeWasmWithString(text) {
  const textBytes = Buffer.from(text, 'latin1');
  const header = Buffer.from([0x01, 0x00, 0x41, 0x00, 0x0b, textBytes.length]);
  const payload = Buffer.concat([header, textBytes]);
  const section = Buffer.concat([Buffer.from([0x0b, payload.length]), payload]);
  return Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), section]);
}

function filmcraftFixture() {
  return buildZip([
    { name: `${FIXTURE_ROOT}/index.html`, data: '<html><head><title>FilmCraft</title></head><body>Loading FilmCraft…</body></html>' },
    { name: `${FIXTURE_ROOT}/filmcraft_web.js`, data: 'window.filmcraft = {};' },
    { name: `${FIXTURE_ROOT}/filmcraft_web_bg.wasm`, data: makeWasmWithString('FilmCraft') },
    { name: `${FIXTURE_ROOT}/audio-worklet.js`, data: 'class P {}' },
    { name: `${FIXTURE_ROOT}/favicon.png`, data: 'png-bytes' },
    { name: `${FIXTURE_ROOT}/README.md`, data: 'upstream readme' },
    { name: `${FIXTURE_ROOT}/LICENSE-MIT`, data: 'upstream license' },
  ]);
}

function effectcraftFixture() {
  return buildZip([
    { name: 'effectcraft-web/index.html', data: '<html><head><title>EffectCraft</title></head></html>' },
    { name: 'effectcraft-web/worker.js', data: 'onmessage=()=>{}' },
    { name: 'effectcraft-web/manifest', data: '{"name":"effectcraft"}' },
  ]);
}

let tmpRoot;
let distDir;
let fixturePath;
let fixtureSha;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-vendor-test-'));
  distDir = path.join(tmpRoot, 'filmcraft-dist');
  fixturePath = path.join(tmpRoot, 'filmcraft-web-0.10.0.zip');
  const buf = filmcraftFixture();
  fs.writeFileSync(fixturePath, buf);
  fixtureSha = sha256Hex(buf);
});

after(() => {
  delete process.env.LOAM_FILMCRAFT_ZIP;
  delete process.env.LOAM_FILMCRAFT_SHA256;
  delete process.env.LOAM_EFFECTCRAFT_ZIP;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('zip extractor', () => {
  it('round-trips stored and deflated entries', () => {
    const buf = buildZip([
      { name: 'a.txt', data: 'stored' },
      { name: 'sub/b.txt', data: 'deflated'.repeat(50), deflate: true },
    ]);
    const out = path.join(tmpRoot, 'zip-out');
    const entries = extractZip(buf, out);
    assert.deepEqual(
      entries.map((e) => e.name).sort(),
      ['a.txt', 'sub/b.txt']
    );
    assert.equal(fs.readFileSync(path.join(out, 'a.txt'), 'utf8'), 'stored');
    assert.equal(fs.readFileSync(path.join(out, 'sub', 'b.txt'), 'utf8'), 'deflated'.repeat(50));
  });

  it('rejects path-traversal entries', () => {
    const buf = buildZip([{ name: '../evil.txt', data: 'x' }]);
    assert.throws(() => extractZip(buf, path.join(tmpRoot, 'zip-evil')), /unsafe entry name/);
  });
});

describe('fetch-filmcraft', () => {
  it('installs from LOAM_FILMCRAFT_ZIP and writes .vendor.json', async () => {
    process.env.LOAM_FILMCRAFT_ZIP = fixturePath;
    process.env.LOAM_FILMCRAFT_SHA256 = fixtureSha;

    const result = await runFilmcraftFetch({ distDir, force: true });
    assert.equal(result.skipped, false);
    assert.ok(fs.existsSync(path.join(distDir, 'index.html')));
    assert.ok(fs.existsSync(path.join(distDir, 'filmcraft_web.js')));
    assert.ok(fs.existsSync(path.join(distDir, 'audio-worklet.js')));
    assert.ok(fs.existsSync(path.join(distDir, 'favicon.png')));
    assert.equal(fs.existsSync(path.join(distDir, 'README.md')), false);
    assert.equal(fs.existsSync(path.join(distDir, 'LICENSE-MIT')), false);

    const meta = JSON.parse(fs.readFileSync(path.join(distDir, '.vendor.json'), 'utf8'));
    assert.equal(meta.version, '0.10.0');
    assert.equal(meta.sha256, fixtureSha);
    assert.match(meta.source, /^file:/);
    assert.ok(meta.fetchedAt);
  });

  it('runs the rebrand step on the vendored copy', async () => {
    const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
    assert.ok(html.includes('Loam Video'));
    assert.ok(!html.includes('FilmCraft'));
    assert.ok(fs.existsSync(path.join(distDir, 'filmcraft_web_bg.wasm')));
  });

  it('aborts on sha mismatch and does not install', async () => {
    const badDir = path.join(tmpRoot, 'filmcraft-bad');
    await assert.rejects(
      () => runFilmcraftFetch({ distDir: badDir, zipPath: fixturePath, sha256: '00'.repeat(32) }),
      /sha256 mismatch/
    );
    assert.equal(fs.existsSync(path.join(badDir, '.vendor.json')), false);
  });

  it('skips when the dist already exists unless --force', async () => {
    const skipDir = path.join(tmpRoot, 'filmcraft-skip');
    fs.mkdirSync(skipDir, { recursive: true });
    fs.writeFileSync(path.join(skipDir, 'index.html'), 'sentinel');

    const result = await runFilmcraftFetch({
      distDir: skipDir,
      zipPath: fixturePath,
      sha256: '00'.repeat(32),
      force: false,
    });
    assert.equal(result.skipped, true);
    assert.equal(fs.readFileSync(path.join(skipDir, 'index.html'), 'utf8'), 'sentinel');

    const forced = await runFilmcraftFetch({
      distDir: skipDir,
      zipPath: fixturePath,
      sha256: fixtureSha,
      force: true,
    });
    assert.equal(forced.skipped, false);
    assert.ok(fs.readFileSync(path.join(skipDir, 'index.html'), 'utf8').includes('Loam Video'));
  });
});

describe('fetch-effectcraft', () => {
  it('reports clearly when nothing is available (no dist, no error)', async () => {
    const emptyCache = path.join(tmpRoot, 'empty-cache');
    fs.mkdirSync(emptyCache, { recursive: true });
    const target = path.join(tmpRoot, 'effectcraft-none');

    const result = await runEffectcraftFetch({ distDir: target, cacheDir: emptyCache });
    assert.equal(result.skipped, true);
    assert.match(result.reason, /LOAM_EFFECTCRAFT_ZIP/);
    assert.equal(fs.existsSync(path.join(target, 'index.html')), false);
  });

  it('installs a local zip when provided', async () => {
    const zip = effectcraftFixture();
    const zipPath = path.join(tmpRoot, 'effectcraft-web-0.1.zip');
    fs.writeFileSync(zipPath, zip);
    const target = path.join(tmpRoot, 'effectcraft-dist');

    const result = await runEffectcraftFetch({
      distDir: target,
      zipPath,
      sha256: sha256Hex(zip),
      force: true,
    });
    assert.equal(result.skipped, false);
    assert.ok(fs.existsSync(path.join(target, 'index.html')));
    assert.ok(fs.existsSync(path.join(target, 'worker.js')));
    assert.ok(fs.existsSync(path.join(target, 'manifest')));
    const meta = JSON.parse(fs.readFileSync(path.join(target, '.vendor.json'), 'utf8'));
    assert.equal(meta.version, 'effectcraft-web-0.1');
  });
});
