import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildKind, BuildManifest, BuildOperation } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { portsFor, runBuildJob, stopBuildJob } from '../serverPorts.js';

function context(workspace: string, kind: string, operation: BuildOperation): BuildJobContext {
  const selection = kind === 'website'
    ? { kind: 'website' as const, subtype: 'landing' as const }
    : { kind: kind as BuildKind };
  return {
    workspace,
    jobId: 'job_port_guard',
    operation,
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection,
      title: 'guard',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
      consent: { autostart: false, publish: false },
    } as BuildManifest,
  };
}

function stableRefusal(error: unknown): boolean {
  return error instanceof BuildMenuError
    && (error.message === 'unsupported_operation' || error.message === 'invalid_request')
    && error.status === 400;
}

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, item.name);
    if (item.isDirectory()) found.push(...filesUnder(absolute));
    else found.push(absolute);
  }
  return found;
}

test('an unknown build-menu port or operation is refused before spawn and writes nothing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-port-guard-'));
  const source = fs.readFileSync(new URL('../serverPorts.ts', import.meta.url), 'utf8');
  try {
    assert.throws(() => portsFor('not-a-port' as BuildKind), stableRefusal);
    assert.throws(() => portsFor(undefined as unknown as BuildKind), stableRefusal);
    await assert.rejects(runBuildJob(context(root, 'not-a-port', { action: 'preview' })), stableRefusal);
    await assert.rejects(runBuildJob(context(root, 'website', { action: 'spawn' } as unknown as BuildOperation)), stableRefusal);
    await assert.rejects(
      runBuildJob({ ...context(root, 'website', { action: 'preview' }), operation: null as unknown as BuildOperation }),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'invalid_request' && error.status === 400,
    );
    await assert.rejects(stopBuildJob(context(root, 'not-a-port', { action: 'preview' })), stableRefusal);
    await assert.rejects(stopBuildJob(context(root, 'website', { action: 'deploy' } as unknown as BuildOperation)), stableRefusal);
    assert.deepEqual(filesUnder(root), []);

    assert.equal(source.includes('spawn('), false);
    assert.equal(source.includes('child_process'), false);
    const runBody = source.slice(source.indexOf('export async function runBuildJob'), source.indexOf('function evidenceRecord'));
    const tryAt = runBody.indexOf('try {');
    assert.ok(tryAt > 0);
    assert.ok(runBody.indexOf('portsFor(') >= 0 && runBody.indexOf('portsFor(') < tryAt);
    assert.ok(runBody.indexOf('refuseUnknownOperation(') >= 0 && runBody.indexOf('refuseUnknownOperation(') < tryAt);
    assert.equal(runBody.slice(0, tryAt).includes('writeJobEvidence'), false);

    const performBody = source.slice(source.indexOf('async function perform'), source.indexOf('export async function stopBuildJob'));
    const refuseAt = performBody.indexOf('refuseUnknownOperation(');
    const driverCalls = ['materialize(', 'driver.preview', 'driver.export', 'driver.executeCell']
      .map((token) => performBody.indexOf(token))
      .filter((at) => at >= 0);
    assert.ok(refuseAt >= 0);
    assert.ok(driverCalls.length === 4);
    assert.ok(driverCalls.every((at) => refuseAt < at));

    const stopBody = source.slice(source.indexOf('export async function stopBuildJob'));
    const stopAt = stopBody.indexOf('.stop(');
    assert.ok(stopBody.indexOf('portsFor(') >= 0 && stopBody.indexOf('portsFor(') < stopAt);
    assert.ok(stopBody.indexOf('refuseUnknownOperation(') >= 0 && stopBody.indexOf('refuseUnknownOperation(') < stopAt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
