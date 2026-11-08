/**
 * Importing the static preview module must not bind a port. The listener
 * belongs to a direct process start, not to require().
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/staticPreviewNoListen.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'staticPreview.cjs');

const importer = [
  "const net = require('node:net');",
  'const script = process.env.LOAM_PREVIEW_SCRIPT;',
  'function ports() {',
  '  const handles = typeof process._getActiveHandles === "function" ? process._getActiveHandles() : [];',
  '  const found = [];',
  '  for (const handle of handles) {',
  '    if (!(handle instanceof net.Server)) continue;',
  '    const address = handle.address();',
  '    if (address && typeof address === "object" && typeof address.port === "number") found.push(address.port);',
  '  }',
  '  found.sort((left, right) => left - right);',
  '  return found;',
  '}',
  'const before = ports();',
  'const loaded = require(script);',
  'setImmediate(() => {',
  '  const after = ports();',
  '  process.stdout.write(JSON.stringify({',
  '    before,',
  '    after,',
  '    exported: typeof loaded.remoteMarkup,',
  '    argv1: process.argv[1] ?? null,',
  '  }));',
  '  process.exit(0);',
  '});',
].join('\n');

type HandleProcess = NodeJS.Process & { _getActiveHandles?: () => unknown[] };

function boundPorts(): number[] {
  const handles = (process as HandleProcess)._getActiveHandles?.() ?? [];
  const ports: number[] = [];
  for (const handle of handles) {
    if (!(handle instanceof net.Server)) continue;
    const address = handle.address();
    if (address && typeof address !== 'string') ports.push(address.port);
  }
  return ports.sort((left, right) => left - right);
}

function closeUnexpected(before: number[]): void {
  const handles = (process as HandleProcess)._getActiveHandles?.() ?? [];
  for (const handle of handles) {
    if (!(handle instanceof net.Server)) continue;
    const address = handle.address();
    if (!address || typeof address === 'string') continue;
    if (before.includes(address.port)) continue;
    handle.close();
  }
}

const portsBeforeImport = boundPorts();
const require = createRequire(import.meta.url);
const loaded = require(script) as { remoteMarkup?: unknown };
const portsAfterImport = boundPorts();

test('importing staticPreview.cjs does not listen on a port', async () => {
  try {
    assert.equal(typeof loaded.remoteMarkup, 'function');
    assert.deepEqual(portsAfterImport, portsBeforeImport);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.deepEqual(boundPorts(), portsBeforeImport);

    const child = spawn(process.execPath, ['-e', importer], {
      env: { ...process.env, LOAM_PREVIEW_SCRIPT: script },
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve(null);
      }, 3_000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0, stderr || stdout);
    assert.equal(stdout.includes('READY'), false);
    assert.equal(stdout.includes('FAIL'), false);
    assert.equal(stdout.includes('EADDRINUSE'), false);
    const report = JSON.parse(stdout) as {
      before: number[];
      after: number[];
      exported: string;
      argv1: string | null;
    };
    assert.equal(report.exported, 'function');
    assert.deepEqual(report.after, report.before);
    const importedAsMain = report.argv1 !== null
      && path.resolve(report.argv1).toLowerCase() === script.toLowerCase();
    assert.equal(importedAsMain, false);
  } finally {
    closeUnexpected(portsBeforeImport);
  }
});
