import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipBuffer } from '../../preview/zip.js';
import { BuildMenuError } from '../grants.js';
import { assertDebugApk } from '../mobile/apk.js';

test('bytes are not called a debug apk unless the archive has the real entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-apk-bytes-'));
  try {
    const plain = zipBuffer([{ name: 'index.html', data: Buffer.from('not an apk') }]);
    assert.throws(
      () => assertDebugApk(plain),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'tool_failed',
    );
    const slipped = storedZip('../classes.dex', Buffer.from('dex'));
    assert.throws(
      () => assertDebugApk(slipped),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'tool_failed',
    );
    const apk = zipBuffer([
      { name: 'classes.dex', data: Buffer.from('dex') },
      { name: 'AndroidManifest.xml', data: Buffer.from('<manifest/>') },
    ]);
    assert.doesNotThrow(() => assertDebugApk(apk));
    assert.equal(fs.readdirSync(root).length, 0);
    const source = fs.readFileSync(path.resolve('src/buildMenu/mobile/apk.ts'), 'utf8');
    const check = source.indexOf('assertDebugApk(bytes)');
    const write = source.indexOf('writeBytesArtifact(workspace');
    assert.equal(check > 0 && write > check, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function storedZip(name: string, data: Buffer): Buffer {
  const encoded = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30 + encoded.length + data.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(encoded.length, 26);
  encoded.copy(local, 30);
  data.copy(local, 30 + encoded.length);
  const central = Buffer.alloc(46 + encoded.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(encoded.length, 28);
  central.writeUInt32LE(local.length, 42);
  encoded.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}
