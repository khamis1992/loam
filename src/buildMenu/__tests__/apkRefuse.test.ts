import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipBuffer } from '../../preview/zip.js';
import { BuildMenuError } from '../grants.js';
import { assertDebugApk, exportDebugApk } from '../mobile/apk.js';

function apkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const absolute = path.join(dir, item.name);
    if (item.isDirectory()) found.push(...apkFiles(absolute));
    else if (item.isFile() && item.name.toLowerCase().endsWith('.apk')) found.push(absolute);
  }
  return found;
}

test('a not-ready Android environment is missing_requirement before any apk build', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-apk-refuse-'));
  const source = fs.readFileSync(path.resolve('src/buildMenu/mobile/apk.ts'), 'utf8');
  const body = source.slice(source.indexOf('export async function exportDebugApk'), source.indexOf('export function assertPackedMobile'));
  try {
    await assert.rejects(
      exportDebugApk(root, 'app_abcdefghijkl', 1, { checks: [{ ready: false }, { ready: true }] }),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'missing_requirement' && error.status === 400,
    );
    assert.deepEqual(apkFiles(root), []);
    assert.equal(fs.existsSync(path.join(root, '.loam')), false);
    const block = body.indexOf("throw new BuildMenuError('missing_requirement', 400)");
    const start = body.indexOf('startAndroidBuild(');
    const artifact = body.indexOf('androidArtifact(');
    assert.equal(block >= 0 && start > block && artifact > block, true);
    assert.match(body, /androidEnvironment\(\)/);
    if (source.includes('refuseApkReady') || source.includes('apkReady')) {
      assert.match(source, /not_an_apk/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assertDebugApk rejects bytes that are not a zip with classes.dex and AndroidManifest.xml', () => {
  const plain = Buffer.from('this is not a zip');
  assert.throws(
    () => assertDebugApk(plain),
    (error: unknown) => error instanceof BuildMenuError && error.message === 'tool_failed' && error.status === 500,
  );
  const html = zipBuffer([{ name: 'index.html', data: Buffer.from('not an apk') }]);
  assert.throws(
    () => assertDebugApk(html),
    (error: unknown) => error instanceof BuildMenuError && error.message === 'tool_failed' && error.status === 500,
  );
  const dexOnly = zipBuffer([{ name: 'classes.dex', data: Buffer.from('dex') }]);
  assert.throws(
    () => assertDebugApk(dexOnly),
    (error: unknown) => error instanceof BuildMenuError && error.message === 'tool_failed' && error.status === 500,
  );
  const manifestOnly = zipBuffer([{ name: 'AndroidManifest.xml', data: Buffer.from('<manifest/>') }]);
  assert.throws(
    () => assertDebugApk(manifestOnly),
    (error: unknown) => error instanceof BuildMenuError && error.message === 'tool_failed' && error.status === 500,
  );
  const apk = zipBuffer([
    { name: 'classes.dex', data: Buffer.from('dex') },
    { name: 'AndroidManifest.xml', data: Buffer.from('<manifest/>') },
  ]);
  assert.doesNotThrow(() => assertDebugApk(apk));
});
