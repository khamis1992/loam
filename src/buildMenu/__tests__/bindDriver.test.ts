import test from 'node:test';
import assert from 'node:assert/strict';
import type { BuildJobContext, BuildProfile, DriverPorts } from '../../../packages/shared/src/buildMenu.js';
import { bindDriver } from '../bindDriver.js';

const profile: BuildProfile = {
  kind: 'website', preview: 'web', requirements: ['node'],
  exports: ['source-zip', 'web-zip'], network: 'loopback', externalEffects: 'approval-required',
};
const ports: DriverPorts = {
  missing: async (_ctx, requirements) => requirements,
  scaffold: async () => undefined,
  preview: async () => ({ kind: 'none' }),
  export: async () => { throw new Error('not_called'); },
  executeCell: async () => { throw new Error('not_called'); },
  stop: async () => undefined,
};
const ctx: BuildJobContext = {
  workspace: '/test-owned', jobId: 'job-test', signal: new AbortController().signal,
  operation: { action: 'preview' },
  manifest: {
    schemaVersion: 1, projectId: 'app_aaaaaaaaaaaa', revision: 1,
    selection: { kind: 'website', subtype: 'landing' }, title: 'test', sourceDir: 'app',
    template: { id: 'fixture', revision: 'test', lockSha256: '0'.repeat(64) },
    consent: { autostart: false, publish: false },
  },
};

test('requirements follow operation, not load action; no cross-kind execution', async () => {
  const driver = bindDriver(profile, ports);
  assert.deepEqual(await driver.preflight(ctx), ['node']);
  assert.deepEqual(await driver.preflight({ ...ctx, operation: { action: 'package', format: 'source-zip' } }), []);
  await assert.rejects(driver.executeCell(ctx, 'cell1'), /unsupported_operation/);
  await assert.rejects(driver.export(ctx, 'portable-exe'), /unsupported_format/);
  await assert.rejects(driver.preview({ ...ctx, manifest: { ...ctx.manifest, selection: { kind: 'desktop' } } }), /kind_mismatch/);
});
