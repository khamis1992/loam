import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildJobContext, BuildProfile } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { createKindPorts } from '../kindRuntime.js';
import { ProcessLeaseRegistry } from '../processLease.js';

const kindRuntimeSource = fileURLToPath(new URL('../kindRuntime.ts', import.meta.url));

const desktopProfile: BuildProfile = {
  kind: 'desktop',
  preview: 'window',
  requirements: ['node', 'electron'],
  exports: ['source-zip', 'portable-exe'],
  network: 'loopback',
  externalEffects: 'approval-required',
};

function sliceBetween(source: string, startMark: string, endMark: string): string {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start + startMark.length);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

test('non-notebook kernel-execute throws unsupported_operation before spawn, and portable-exe writes no file', async () => {
  const source = fs.readFileSync(kindRuntimeSource, 'utf8');
  const cell = sliceBetween(source, 'async executeCell', 'async stop');
  const guard = cell.indexOf("throw new BuildMenuError('unsupported_operation', 400)");
  const kernel = cell.indexOf('runKernelCell(');
  assert.match(cell, /profile\.kind !== 'notebook'/);
  assert.equal(guard >= 0 && kernel > guard, true);
  assert.equal(cell.includes('spawn('), false);
  const portable = sliceBetween(source, "case 'portable-exe':", "case 'xcode-source':");
  assert.match(portable, /return requestPortableExeBytes\(ctx\.workspace\)/);
  assert.equal(portable.includes('spawn'), false);
  assert.equal(portable.includes('writeFile'), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-kind-cell-'));
  const leases = new ProcessLeaseRegistry(500);
  const ports = createKindPorts(desktopProfile, { leases, electronExecutable: null });
  const ctx: BuildJobContext = {
    workspace: root,
    jobId: 'job_desktop_cell',
    operation: { action: 'kernel-execute', cellId: 'cell-1' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection: { kind: 'desktop' },
      title: 'مكتب',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
  try {
    await assert.rejects(
      ports.executeCell(ctx, 'cell-1'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'unsupported_operation' && error.status === 400,
    );
    assert.equal(leases.liveCount(), 0);
    const packaged: BuildJobContext = { ...ctx, operation: { action: 'package', format: 'portable-exe' } };
    await assert.rejects(
      ports.export(packaged, 'portable-exe'),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'missing_requirement' && error.status === 400,
    );
    assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(fs.existsSync(path.join(root, '.loam', 'build-menu', 'artifacts')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
