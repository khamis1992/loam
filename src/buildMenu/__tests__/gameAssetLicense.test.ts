import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gameAssetManifest, writeListedGameAssets } from '../games/assets.js';

const HASH = 'a'.repeat(64);

function listed(filePath: string, license?: string) {
  return {
    path: filePath,
    source: 'local-geometry',
    license,
    evidenceSha256: HASH,
  };
}

test('a missing license is refused before a game asset is written', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-game-license-'));
  try {
    fs.writeFileSync(path.join(root, 'keep.txt'), 'stay');
    const valid = listed('assets/hero.png', 'CC0-1.0');
    assert.throws(() => writeListedGameAssets(root, [valid, listed('assets/next.png')]), /missing_license/);
    assert.throws(() => writeListedGameAssets(root, [listed('assets/hero.png', '   ')]), /missing_license/);
    assert.throws(() => writeListedGameAssets(root, [{ path: 'assets/hero.png', source: 'local-geometry', evidenceSha256: HASH }]), /missing_license/);
    assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'stay');
    assert.deepEqual(fs.readdirSync(root), ['keep.txt']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a path that leaves the game folder is refused before write', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-game-license-'));
  const outsideName = `secret-${path.basename(root)}.png`;
  try {
    fs.writeFileSync(path.join(root, 'keep.txt'), 'stay');
    writeListedGameAssets(root, []);
    const manifestPath = path.join(root, 'assets', 'manifest.json');
    const before = fs.readFileSync(manifestPath);
    for (const filePath of [`../${outsideName}`, 'assets/../../outside.png', '/etc/passwd', 'C:/secret.png', 'assets\\secret.png', 'https://evil.example/a.png']) {
      assert.throws(() => writeListedGameAssets(root, [listed(filePath, 'local')]), /unsafe_path/);
    }
    assert.equal(fs.readFileSync(manifestPath).equals(before), true);
    assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'stay');
    assert.equal(fs.existsSync(path.join(path.dirname(root), outsideName)), false);
    assert.equal(fs.existsSync(path.join(root, 'assets', 'hero.png')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the geometric fixture may list no downloaded file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-game-license-'));
  try {
    writeListedGameAssets(root, []);
    const empty = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'manifest.json'), 'utf8')) as { assets: unknown[] };
    assert.deepEqual(empty.assets, []);
    assert.deepEqual(fs.readdirSync(path.join(root, 'assets')), ['manifest.json']);
    assert.deepEqual(JSON.parse(gameAssetManifest([])), { assets: [] });

    const manifestPath = path.join(root, 'assets', 'manifest.json');
    const before = fs.readFileSync(manifestPath);
    assert.throws(() => writeListedGameAssets(root, [listed('assets/hero.png', 'local')]), /unsafe_path/);
    assert.equal(fs.readFileSync(manifestPath).equals(before), true);
    assert.equal(fs.existsSync(path.join(root, 'assets', 'hero.png')), false);
    assert.deepEqual(fs.readdirSync(path.join(root, 'assets')), ['manifest.json']);

    const text = '{"speed":200,"gravity":700}\n';
    const generated = JSON.parse(gameAssetManifest([{ path: 'tuning.json', text }])) as { assets: { path: string; source: string; license: string; evidenceSha256: string }[] };
    assert.equal(generated.assets[0]?.path, 'tuning.json');
    assert.equal(generated.assets[0]?.source, 'local-geometry');
    assert.equal(generated.assets[0]?.license, 'local');
    assert.equal(generated.assets[0]?.evidenceSha256, createHash('sha256').update(text).digest('hex'));
    assert.equal(fs.existsSync(path.join(root, 'tuning.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a listed file is recorded only when its bytes match the evidence hash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-game-license-'));
  try {
    assert.throws(() => writeListedGameAssets(root, [listed('assets/hero.png', 'local')]), /unsafe_path/);
    assert.equal(fs.existsSync(root) && fs.readdirSync(root).length === 0, true);
    assert.equal(fs.existsSync(path.join(root, 'assets', 'hero.png')), false);
    assert.equal(fs.existsSync(path.join(root, 'assets', 'manifest.json')), false);

    const hero = path.join(root, 'assets', 'hero.png');
    fs.mkdirSync(path.dirname(hero), { recursive: true });
    const bytes = Buffer.from('local-geometry');
    fs.writeFileSync(hero, bytes);
    const mismatch = listed('assets/hero.png', 'local');
    assert.throws(() => writeListedGameAssets(root, [mismatch]), /unsafe_path/);
    assert.equal(fs.existsSync(path.join(root, 'assets', 'manifest.json')), false);
    assert.equal(fs.readFileSync(hero).equals(bytes), true);

    const evidenceSha256 = createHash('sha256').update(bytes).digest('hex');
    const entry = { path: 'assets/hero.png', source: 'local-geometry', license: 'local', evidenceSha256 };
    writeListedGameAssets(root, [entry]);
    const manifestPath = path.join(root, 'assets', 'manifest.json');
    const written = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { assets: Record<string, string>[] };
    assert.deepEqual(written.assets, [entry]);
    assert.deepEqual(Object.keys(written.assets[0] ?? {}).sort(), ['evidenceSha256', 'license', 'path', 'source']);
    assert.equal(fs.readFileSync(hero).equals(bytes), true);

    fs.writeFileSync(hero, Buffer.from('tampered'));
    const before = fs.readFileSync(manifestPath);
    assert.throws(() => writeListedGameAssets(root, [entry]), /unsafe_path/);
    assert.equal(fs.readFileSync(manifestPath).equals(before), true);
    assert.equal(fs.readFileSync(hero).equals(Buffer.from('tampered')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
