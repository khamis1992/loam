import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipBuffer } from '../../preview/zip.js';
import { writeSourceArtifact } from '../artifacts.js';

test('a source archive refuses a path that leaves the project and does not run it', () => {
  const names = ['../secret.txt', 'foo/../../etc/passwd', '/tmp/x', 'C:/Windows/x', 'a\\..\\b', 'a//b'];
  const missed: string[] = [];
  for (const name of names) {
    try {
      zipBuffer([{ name, data: Buffer.from('x') }]);
      missed.push(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /zip: unsafe entry name/);
    }
  }
  assert.deepEqual(missed, []);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-zip-slip-'));
  try {
    fs.mkdirSync(path.join(root, 'app'));
    fs.writeFileSync(path.join(root, 'app', 'notes.txt'), 'local');
    fs.writeFileSync(path.join(root, 'app', '.env'), 'TOKEN=secret');
    const artifact = writeSourceArtifact(root, 'app_abcdefghijkl', 1, 'source-zip');
    const bytes = fs.readFileSync(path.join(root, artifact.relativePath));
    assert.equal(artifact.bytes, bytes.length);
    assert.equal(artifact.sha256.length, 64);
    const names = centralNames(bytes);
    assert.deepEqual(names, ['notes.txt']);
    assert.equal(names.some((name) => name.includes('..') || name.startsWith('/') || name.includes(':')), false);
    const route = fs.readFileSync(path.resolve('src/server/routes/buildMenu.ts'), 'utf8');
    const download = route.slice(route.indexOf('artifacts'), route.indexOf('const jobMatch'));
    assert.match(download, /res\.end\(loaded\.bytes\)/);
    assert.equal(download.includes('spawn'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function centralNames(zip: Buffer): string[] {
  const marker = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = zip.lastIndexOf(marker);
  const count = zip.readUInt16LE(eocd + 10);
  let cursor = zip.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
    const nameLen = zip.readUInt16LE(cursor + 28);
    names.push(zip.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8'));
    cursor += 46 + nameLen;
  }
  return names;
}
