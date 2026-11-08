import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { absentRequirements, nodeSupported } from '../toolchain.js';

test('the build menu requires Node 24 and does not copy the older preflight', () => {
  assert.equal(nodeSupported('22.13.0'), false);
  assert.equal(nodeSupported('v22.13.1'), false);
  assert.equal(nodeSupported('23.11.0'), false);
  assert.equal(nodeSupported('24.0.0'), true);
  assert.equal(nodeSupported('v24.11.0'), true);
  assert.equal(nodeSupported('not-a-version'), false);
  const major = Number(process.versions.node.split('.')[0]);
  assert.equal(absentRequirements(['node']).includes('node'), major < 24);
  const toolchain = fs.readFileSync(path.resolve('src/buildMenu/toolchain.ts'), 'utf8');
  const runtime = fs.readFileSync(path.resolve('src/buildMenu/kindRuntime.ts'), 'utf8');
  assert.equal(toolchain.includes('22.13'), false);
  const serve = runtime.slice(runtime.indexOf('async function serveFile'), runtime.indexOf('function healthMarker'));
  const check = serve.indexOf('nodeSupported()');
  const start = serve.indexOf('leases.start');
  assert.equal(check >= 0 && start > check, true);
});
