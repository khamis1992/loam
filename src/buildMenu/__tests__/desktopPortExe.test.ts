import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildOperation } from '../../../packages/shared/src/buildMenu.js';
import { createDesktopPorts } from '../desktop/ports.js';
import { BuildMenuError } from '../grants.js';
import { ProcessLeaseRegistry } from '../processLease.js';

function context(workspace: string, operation: BuildOperation): BuildJobContext {
  return {
    workspace,
    jobId: 'job_desktop_port_exe',
    operation,
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
}

function refused(code: string) {
  return (error: unknown) => error instanceof BuildMenuError && error.message === code && error.status === 400;
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const absolute = path.join(dir, item.name);
    if (item.isDirectory()) found.push(...listFiles(absolute));
    else if (item.isFile()) found.push(absolute);
  }
  return found.sort();
}

function assertReportedFlags(ports: object): void {
  const record = ports as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!/status|portable|signed|built/i.test(key)) continue;
    const value = record[key];
    const status = typeof value === 'function' && value.length === 0 ? value.call(ports) : value;
    if (!status || typeof status !== 'object') continue;
    const flags = status as { signed?: unknown; built?: unknown };
    if ('signed' in flags) assert.equal(flags.signed, false);
    if ('built' in flags) assert.equal(flags.built, false);
  }
}

test('desktop portable-exe export throws missing_requirement and writes no exe', async () => {
  const source = fs.readFileSync(new URL('../desktop/ports.ts', import.meta.url), 'utf8');
  assert.equal(/signed\s*:\s*true/.test(source), false);
  assert.equal(/built\s*:\s*true/.test(source), false);
  assert.equal(source.includes('.exe'), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-desktop-port-exe-'));
  const leases = new ProcessLeaseRegistry(200);
  const ports = createDesktopPorts({ leases, electronExecutable: null });
  const cell = context(root, { action: 'kernel-execute', cellId: 'cell-1' });
  const packaged = context(root, { action: 'package', format: 'portable-exe' });
  try {
    assertReportedFlags(ports);
    await assert.rejects(ports.executeCell(cell, 'cell-1'), refused('unsupported_operation'));
    await assert.rejects(
      ports.executeCell({ ...cell, operation: { action: 'preview' } }, 'cell-1'),
      refused('unsupported_operation'),
    );
    await assert.rejects(ports.export(packaged, 'portable-exe'), refused('missing_requirement'));
    assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(fs.existsSync(path.join(root, '.loam', 'build-menu', 'artifacts')), false);
    assert.equal(leases.liveCount(), 0);

    await ports.scaffold(cell);
    const before = listFiles(root);
    assert.equal(before.some((file) => file.toLowerCase().endsWith('.exe')), false);
    await assert.rejects(ports.export(packaged, 'portable-exe'), refused('missing_requirement'));
    await assert.rejects(ports.executeCell(cell, 'cell-1'), refused('unsupported_operation'));
    assert.deepEqual(listFiles(root), before);
    assert.equal(listFiles(root).some((file) => file.toLowerCase().endsWith('.exe')), false);
    assert.equal(fs.existsSync(path.join(root, '.loam', 'build-menu', 'artifacts')), false);
    assert.equal(leases.liveCount(), 0);
    assertReportedFlags(ports);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
