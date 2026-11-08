import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractZip, zipBuffer } from '../../preview/zip.js';
import { writeBytesArtifact } from '../artifacts.js';

test('unpacking a web zip stays inside the folder and keeps the saved revision', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-zip-extract-'));
  const outside = path.join(root, 'outside.txt');
  try {
    const page = Buffer.from('console.log("local")\n');
    const html = Buffer.from('<!doctype html><script src="./page.js"></script>');
    const bytes = zipBuffer([
      { name: 'index.html', data: html },
      { name: 'page.js', data: page },
    ]);
    const artifact = writeBytesArtifact(root, 'app_abcdefghijkl', 4, 'web-zip', bytes, 'zip');
    fs.mkdirSync(path.join(root, 'app'));
    fs.writeFileSync(path.join(root, 'app', 'preview.html'), 'changed after export');
    const saved = fs.readFileSync(path.join(root, artifact.relativePath));
    const meta = JSON.parse(fs.readFileSync(path.join(root, '.loam', 'build-menu', 'artifacts', `${artifact.artifactId}.json`), 'utf8')) as { revision: number; sha256: string; bytes: number };
    assert.equal(meta.revision, 4);
    assert.equal(meta.bytes, saved.length);
    assert.equal(meta.sha256, createHash('sha256').update(saved).digest('hex'));
    assert.equal(saved.equals(bytes), true);
    const dest = path.join(root, 'unpacked');
    fs.mkdirSync(dest);
    assert.deepEqual(extractZip(saved, dest).sort(), ['index.html', 'page.js']);
    assert.equal(fs.readFileSync(path.join(dest, 'page.js')).equals(page), true);
    assert.equal(fs.existsSync(outside), false);

    assert.throws(() => extractZip(storedZip([{ name: '../outside.txt', data: Buffer.from('nope') }]), dest), /zip: unsafe entry name/);
    assert.throws(() => extractZip(storedZip([
      { name: 'index.html', data: html },
      { name: '../outside.txt', data: Buffer.from('nope') },
    ]), dest), /zip: unsafe entry name/);
    assert.throws(() => extractZip(zipBuffer([{ name: '.env', data: Buffer.from('TOKEN=secret') }]), dest), /zip: unsafe entry name/);
    assert.throws(() => extractZip(zipBuffer([{ name: 'node_modules/pkg/index.js', data: Buffer.from('x') }]), dest), /zip: unsafe entry name/);
    assert.throws(() => extractZip(zipBuffer([{ name: '.loam/plan.json', data: Buffer.from('{}') }]), dest), /zip: unsafe entry name/);
    assert.equal(fs.existsSync(outside), false);
    assert.equal(fs.existsSync(path.join(dest, '.env')), false);
    assert.equal(fs.readFileSync(path.join(dest, 'index.html')).equals(html), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function storedZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, entry.data);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + entry.data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data[i] ?? 0;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
