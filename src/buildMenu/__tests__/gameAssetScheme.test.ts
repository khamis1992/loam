import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gameAssetManifest, writeListedGameAssets } from '../games/assets.js';

const SCHEME_BASES = [
  'mailto:user@example.test',
  'MAILTO:user@example.test',
  'mailto :user@example.test',
  'tel:+97400000000',
  'TEL:+97400000000',
  'sms:+97400000000',
  'SMS:+97400000000',
  'sms :97400000000',
  'intent:scan',
  'INTENT:scan',
  'intent :scan',
  'market:details?id=app',
  'market://details?id=app',
  'MARKET:details',
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'javascript :alert(1)',
  'https://evil.example/a',
  'http://evil.example/a',
  'HTTPS://evil.example/a',
  'HTTP://evil.example/a',
  'data:text/html,hi',
  'DATA:text/html,hi',
  'data :text/html,hi',
  'file:///c:/secret',
  'FILE:///c:/secret',
  'file :///c:/secret',
  'blob:null/uuid',
  'BLOB:null/uuid',
  '//evil.example/a',
  '//EVIL.example/a',
];

const ENCODED_EXTRAS = [
  'java%73cript:alert(1)',
  'java%2573cript%253Aalert(1)',
  'mail%74o:user@example.test',
  'mail%2574o%253Auser@example.test',
  'https:%2F%2Fevil.example/a',
  'https:%252F%252Fevil.example/a',
  'http:%2F%2Fevil.example/a',
  'http:%252F%252Fevil.example/a',
  '%2F%2Fevil.example/a',
  '%252F%252Fevil.example/a',
  '%2f%2fevil.example/a',
  '%252f%252fevil.example/a',
  'javascript%00:alert(1)',
  'java%00script:alert(1)',
  'file%00:///c:/secret',
  'mailto%0a:user@example.test',
  'mailto%250a:user@example.test',
];

type AssetField = 'license' | 'source' | 'path';

function encodeMarks(value: string): string {
  return value.replace(/[:/]/g, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function encodePercents(value: string): string {
  return value.replace(/%/g, '%25');
}

function encodeAll(value: string): string {
  return [...Buffer.from(value)].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');
}

function forms(value: string): string[] {
  const marks = encodeMarks(value);
  const full = encodeAll(value);
  return [
    value,
    marks,
    marks.toUpperCase(),
    encodePercents(marks),
    encodePercents(marks).toUpperCase(),
    full,
    full.toUpperCase(),
    encodePercents(full),
    encodePercents(full).toUpperCase(),
  ];
}

function schemeAttacks(): string[] {
  const seen = new Set<string>();
  const attacks: string[] = [];
  for (const base of SCHEME_BASES) {
    for (const form of forms(base)) {
      if (seen.has(form)) continue;
      seen.add(form);
      attacks.push(form);
    }
  }
  for (const extra of ENCODED_EXTRAS) {
    if (seen.has(extra)) continue;
    seen.add(extra);
    attacks.push(extra);
  }
  return attacks;
}

function unsafePath(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function missingLicense(error: unknown): boolean {
  return error instanceof Error && error.message === 'missing_license';
}

function withTemp(run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-41-game-asset-'));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function entry(field: AssetField, attack: string, evidenceSha256: string): { path: string; source: string; license: string; evidenceSha256: string } {
  switch (field) {
    case 'license':
      return { path: 'assets/hero.png', source: 'local-geometry', license: attack, evidenceSha256 };
    case 'source':
      return { path: 'assets/hero.png', source: attack, license: 'local', evidenceSha256 };
    case 'path':
      return { path: attack, source: 'local-geometry', license: 'local', evidenceSha256 };
    default: {
      const unreachable: never = field;
      throw new Error(unreachable);
    }
  }
}

test('an empty asset list writes only the manifest and a local file still records', () => {
  withTemp((root) => {
    const manifestPath = path.join(root, 'assets', 'manifest.json');
    writeListedGameAssets(root, []);
    assert.deepEqual(fs.readdirSync(path.join(root, 'assets')), ['manifest.json']);
    const emptyBytes = fs.readFileSync(manifestPath);
    assert.deepEqual(JSON.parse(emptyBytes.toString('utf8')), { assets: [] });

    const hero = path.join(root, 'assets', 'hero.png');
    const bytes = Buffer.from('local-geometry');
    fs.writeFileSync(hero, bytes);
    const evidenceSha256 = createHash('sha256').update(bytes).digest('hex');
    const good = { path: 'assets/hero.png', source: 'local-geometry', license: 'local', evidenceSha256 };
    writeListedGameAssets(root, [good]);
    const saved = fs.readFileSync(manifestPath);
    assert.equal(saved.equals(emptyBytes), false);
    const written = JSON.parse(saved.toString('utf8')) as { assets: typeof good[] };
    assert.deepEqual(written.assets, [good]);
    assert.equal(fs.readFileSync(hero).equals(bytes), true);

    const wordy = { ...good, license: 'https: data file mailto tel market intent blob javascript local' };
    writeListedGameAssets(root, [wordy]);
    const wordyManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { assets: { license: string }[] };
    assert.equal(wordyManifest.assets[0]?.license, wordy.license);
    writeListedGameAssets(root, [good]);
    assert.equal(fs.readFileSync(manifestPath).equals(saved), true);

    assert.throws(() => writeListedGameAssets(root, [{ ...good, evidenceSha256: 'b'.repeat(64) }]), unsafePath);
    assert.throws(() => writeListedGameAssets(root, [{ ...good, evidenceSha256: 'abc' }]), unsafePath);
    fs.writeFileSync(hero, Buffer.from('tampered'));
    assert.throws(() => writeListedGameAssets(root, [good]), unsafePath);
    assert.equal(fs.readFileSync(hero).equals(Buffer.from('tampered')), true);
    fs.writeFileSync(hero, bytes);
    assert.throws(() => writeListedGameAssets(root, [{ path: good.path, source: good.source, evidenceSha256 }]), missingLicense);
    assert.throws(() => writeListedGameAssets(root, [{ ...good, license: '   ' }]), missingLicense);
    assert.throws(() => writeListedGameAssets(root, 'local' as unknown as readonly unknown[]), missingLicense);
    assert.equal(fs.readFileSync(manifestPath).equals(saved), true);
    assert.equal(fs.readFileSync(hero).equals(bytes), true);
    assert.deepEqual(fs.readdirSync(path.join(root, 'assets')).sort(), ['hero.png', 'manifest.json']);
  });
});

test('license, source, and path reject schemes without changing the manifest', () => {
  withTemp((root) => {
    const manifestPath = path.join(root, 'assets', 'manifest.json');
    const attacks = schemeAttacks();
    assert.ok(attacks.length > 100);
    assert.throws(
      () => writeListedGameAssets(root, [{ path: 'assets/hero.png', source: 'local-geometry', license: 'mailto:user@example.test', evidenceSha256: 'a'.repeat(64) }]),
      unsafePath,
    );
    assert.equal(fs.existsSync(manifestPath), false);

    const hero = path.join(root, 'assets', 'hero.png');
    const bytes = Buffer.from('local-geometry');
    fs.mkdirSync(path.dirname(hero), { recursive: true });
    fs.writeFileSync(hero, bytes);
    const evidenceSha256 = createHash('sha256').update(bytes).digest('hex');
    const good = { path: 'assets/hero.png', source: 'local-geometry', license: 'local', evidenceSha256 };
    writeListedGameAssets(root, [good]);
    const saved = fs.readFileSync(manifestPath);
    const fields: readonly AssetField[] = ['license', 'source', 'path'];
    for (const attack of attacks) {
      for (const field of fields) {
        const samples = field === 'path' ? [attack] : [attack, `see ${attack}`];
        for (const sample of samples) {
          assert.throws(() => writeListedGameAssets(root, [entry(field, sample, evidenceSha256)]), unsafePath, `${field} ${sample}`);
          assert.equal(fs.readFileSync(manifestPath).equals(saved), true, `${field} ${sample}`);
        }
      }
    }
    const shifted = { ...good, license: 'CC0-1.0' };
    assert.throws(() => writeListedGameAssets(root, [shifted, { ...good, license: 'mailto:user@example.test' }]), unsafePath);
    assert.equal(fs.readFileSync(manifestPath).equals(saved), true);
    assert.equal(fs.readFileSync(hero).equals(bytes), true);
    const stat = fs.lstatSync(manifestPath);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.deepEqual(fs.readdirSync(root), ['assets']);
    assert.deepEqual(fs.readdirSync(path.join(root, 'assets')).sort(), ['hero.png', 'manifest.json']);
  });
});

test('a generated manifest keeps local geometry and rejects scheme paths', () => {
  const text = 'local-geometry';
  const manifest = gameAssetManifest([{ path: 'tuning.json', text }]);
  const parsed = JSON.parse(manifest) as { assets: { path: string; source: string; license: string; evidenceSha256: string }[] };
  assert.equal(parsed.assets[0]?.path, 'tuning.json');
  assert.equal(parsed.assets[0]?.source, 'local-geometry');
  assert.equal(parsed.assets[0]?.license, 'local');
  assert.equal(parsed.assets[0]?.evidenceSha256, createHash('sha256').update(text).digest('hex'));
  assert.deepEqual(JSON.parse(gameAssetManifest([])), { assets: [] });
  for (const attack of schemeAttacks()) {
    assert.throws(() => gameAssetManifest([{ path: attack, text: 'x' }]), unsafePath, attack);
  }
});
