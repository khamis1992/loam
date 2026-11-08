import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { BuildJobContext, BuildManifest, ExportKind } from '../../../packages/shared/src/buildMenu.js';
import { createGamesPorts } from '../games/ports.js';
import { BuildMenuError } from '../grants.js';
import { ProcessLeaseRegistry } from '../processLease.js';

function context(workspace: string, operation: BuildJobContext['operation']): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'game' };
  return {
    workspace,
    jobId: 'job_game_port_cell',
    operation,
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection,
      title: 'لعبة',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}

function refused(code: string) {
  return (error: unknown) => error instanceof BuildMenuError && error.message === code && error.status === 400;
}

function zipNames(buffer: Buffer): string[] {
  const names: string[] = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressed = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    names.push(buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'));
    offset += 30 + nameLength + extraLength + compressed;
  }
  return names;
}

function nativeBuildName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.apk')
    || lower.endsWith('.exe')
    || lower.includes('electron/')
    || lower.includes('androidmanifest.xml')
    || lower.endsWith('.aab');
}

test('game executeCell is unsupported and export does not claim a native mobile or Electron build', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-game-port-cell-'));
  const leases = new ProcessLeaseRegistry(200);
  const ports = createGamesPorts({ leases });
  const preview = context(root, { action: 'preview' });
  const cell = context(root, { action: 'kernel-execute', cellId: 'cell-1' });
  try {
    await assert.rejects(ports.executeCell(cell, 'cell-1'), refused('unsupported_operation'));
    await assert.rejects(ports.executeCell(preview, 'cell-1'), refused('unsupported_operation'));
    assert.equal(leases.liveCount(), 0);

    await ports.scaffold(preview);
    for (const format of ['apk-debug', 'portable-exe'] as const) {
      await assert.rejects(ports.export(preview, format), refused('unsupported_format'));
    }
    assert.equal(walkNative(root), false);

    const packed: ExportKind[] = [];
    for (const format of ['source-zip', 'web-zip'] as const) {
      const artifact = await ports.export(preview, format);
      packed.push(artifact.format);
      assert.equal(artifact.format, format);
      assert.equal(artifact.relativePath.toLowerCase().endsWith('.apk'), false);
      assert.equal(artifact.relativePath.toLowerCase().endsWith('.exe'), false);
      const names = zipNames(fs.readFileSync(path.join(root, artifact.relativePath)));
      assert.equal(names.some(nativeBuildName), false);
      assert.ok(names.includes('index.html'));
    }
    assert.deepEqual(packed, ['source-zip', 'web-zip']);
    assert.equal(leases.liveCount(), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function walkNative(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const child = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name === 'electron' || walkNative(child)) return true;
    } else if (nativeBuildName(item.name)) return true;
  }
  return false;
}
