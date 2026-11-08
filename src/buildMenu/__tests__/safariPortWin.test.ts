import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { materialize } from '../materialize.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { currentConversion } from '../safari/platform.js';
import { createSafariPorts } from '../safari/ports.js';

function context(workspace: string, format: 'source-zip' | 'xcode-source'): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'safari-extension' };
  return {
    workspace,
    jobId: 'job_safari_port_win',
    operation: { action: 'package', format },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection,
      title: 'ملاحظة',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'b'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}

function listFiles(root: string): string[] {
  const names: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      names.push(path.relative(root, absolute).replaceAll('\\', '/'));
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(absolute);
    }
  };
  walk(root);
  names.sort();
  return names;
}

function xcodePath(name: string): boolean {
  return name.includes('.xcodeproj') || name.includes('.xcworkspace') || name.endsWith('.pbxproj') || name.endsWith('.xcscheme');
}

function unzip(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressed = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    const body = buffer.subarray(start, start + compressed);
    files.set(name, method === 0 ? Buffer.from(body) : zlib.inflateRawSync(body));
    offset = start + compressed;
  }
  return files;
}

test('win32 xcode-source export throws unsupported_platform and writes no Xcode project', async () => {
  assert.equal(process.platform, 'win32');
  assert.equal(currentConversion(), 'source-only');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-safari-port-win-'));
  const ports = createSafariPorts({ leases: new ProcessLeaseRegistry(200) });
  try {
    materialize({ selection: { kind: 'safari-extension' }, workspace: root, title: 'ملاحظة' });
    const conversionPath = path.join(root, 'app', 'conversion.json');
    const original = fs.readFileSync(conversionPath);
    const stored = JSON.parse(original.toString('utf8')) as { conversion: string; platform: string; safariTested: boolean };
    assert.equal(stored.conversion, 'source-only');
    assert.equal(stored.platform, 'win32');
    assert.equal(stored.safariTested, false);
    const before = listFiles(root);
    assert.equal(before.some(xcodePath), false);
    await assert.rejects(
      ports.export(context(root, 'xcode-source'), 'xcode-source'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsupported_platform' && error.status === 400,
    );
    assert.deepEqual(listFiles(root), before);
    assert.equal(listFiles(root).some(xcodePath), false);
    assert.equal(fs.readFileSync(conversionPath).equals(original), true);
    assert.equal(JSON.parse(fs.readFileSync(conversionPath, 'utf8')).safariTested, false);
    const artifact = await ports.export(context(root, 'source-zip'), 'source-zip');
    const packed = unzip(fs.readFileSync(path.join(root, artifact.relativePath)));
    const conversion = JSON.parse(packed.get('conversion.json')?.toString('utf8') ?? '') as { conversion: string; safariTested: boolean };
    assert.equal(conversion.conversion, 'source-only');
    assert.equal(conversion.safariTested, false);
    assert.equal([...packed.keys()].some(xcodePath), false);
    assert.equal(listFiles(root).some(xcodePath), false);
    const after = JSON.parse(fs.readFileSync(conversionPath, 'utf8')) as { conversion: string; safariTested: boolean };
    assert.equal(after.conversion, 'source-only');
    assert.equal(after.safariTested, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
