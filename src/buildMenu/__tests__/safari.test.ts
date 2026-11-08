import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { materialize } from '../materialize.js';
import { createSafariPorts } from '../safari/ports.js';
import { conversionCapability, currentConversion, macHandoffNote } from '../safari/platform.js';
import { safariBrief, safariProfile } from '../safari/profile.js';
import { ProcessLeaseRegistry } from '../processLease.js';

const require = createRequire(path.resolve('packages/web/package.json'));
const { chromium } = require('playwright') as {
  chromium: {
    launch(options: { headless: boolean }): Promise<{
      newPage(): Promise<{
        goto(url: string): Promise<void>;
        close(): Promise<void>;
        on(event: 'request', handler: (request: { url(): string }) => void): void;
        locator(selector: string): { click(): Promise<void>; textContent(): Promise<string | null> };
      }>;
      close(): Promise<void>;
    }>;
  };
};

test('safari-extension: fixed capability boundary', () => {
  assert.equal(safariProfile.kind, 'safari-extension');
  assert.equal(safariProfile.preview, 'extension');
  assert.equal(safariProfile.externalEffects, 'approval-required');
  assert.ok(safariProfile.exports.includes('source-zip'));
  assert.ok(safariBrief.length > 40);
});

test('the Safari converter stops before xcrun on this machine', () => {
  const script = path.resolve('scripts/build-menu/safari-convert.sh');
  const source = fs.readFileSync(script, 'utf8').replace(/\r\n/g, '\n');
  fs.writeFileSync(script, source);
  assert.ok(source.indexOf('uname -s') < source.indexOf('xcrun'));
  assert.equal(source.includes('codesign'), false);
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  if (process.platform === 'darwin' || !fs.existsSync(bash)) return;
  const result = spawnSync(bash, [script], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr ?? '', /unsupported_platform/);
  assert.equal((result.stdout ?? '').includes('conversion finished'), false);
  assert.equal((result.stderr ?? '').includes('xcrun'), false);
});

test('Safari conversion is not a Windows feature', () => {
  assert.equal(conversionCapability('win32', true), 'source-only');
  assert.equal(conversionCapability('darwin', false), 'missing-xcode');
  assert.equal(conversionCapability('darwin', true), 'convertible');
});

test('Safari source on this machine matches Chrome and does not claim a tested extension', async () => {
  const chrome = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-safari-'));
  const safari = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-safari-'));
  const ports = createSafariPorts({ leases: new ProcessLeaseRegistry(200) });
  const selection: BuildManifest['selection'] = { kind: 'safari-extension' };
  const ctx: BuildJobContext = {
    workspace: safari,
    jobId: 'job_safari_source',
    operation: { action: 'package', format: 'source-zip' },
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
  try {
    materialize({ selection: { kind: 'chrome-extension' }, workspace: chrome, title: 'ملاحظة' });
    materialize({ selection, workspace: safari, title: 'ملاحظة' });
    const chromeScript = fs.readFileSync(path.join(chrome, 'app', 'popup.js'));
    const safariScript = fs.readFileSync(path.join(safari, 'app', 'popup.js'));
    assert.equal(createHash('sha256').update(safariScript).digest('hex'), createHash('sha256').update(chromeScript).digest('hex'));
    assert.match(fs.readFileSync(path.join(safari, 'app', 'popup.html'), 'utf8'), /id="safari-untested"/);
    assert.equal(fs.readFileSync(path.join(chrome, 'app', 'popup.html'), 'utf8').includes('safari-untested'), false);
    assert.equal(fs.readFileSync(path.join(safari, 'app', 'README-mac.md'), 'utf8'), macHandoffNote());
    const artifact = await ports.export(ctx, 'source-zip');
    const names = [...unzip(fs.readFileSync(path.join(safari, artifact.relativePath))).keys()];
    assert.equal(names.includes('README-mac.md'), true);
    assert.equal(names.includes('popup.js'), true);
    assert.equal(names.some((name) => name.includes('.xcodeproj')), false);
    const conversion = JSON.parse(fs.readFileSync(path.join(safari, 'app', 'conversion.json'), 'utf8')) as { conversion: string; safariTested: boolean };
    assert.equal(conversion.conversion, currentConversion());
    assert.equal(conversion.safariTested, false);
  } finally {
    fs.rmSync(chrome, { recursive: true, force: true });
    fs.rmSync(safari, { recursive: true, force: true });
  }
});

test('a Safari preview serves the shared script and says Safari was not tested', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-safari-preview-'));
  const ports = createSafariPorts({ leases: new ProcessLeaseRegistry(200) });
  const ctx: BuildJobContext = {
    workspace: root,
    jobId: 'job_safari_preview',
    operation: { action: 'preview' },
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_bcdfghjkmnpq',
      revision: 1,
      selection: { kind: 'safari-extension' },
      title: 'ملاحظة',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'b'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
  const browser = await chromium.launch({ headless: true });
  try {
    await ports.scaffold(ctx);
    const preview = await ports.preview(ctx);
    assert.equal(preview.kind, 'http');
    if (preview.kind !== 'http') return;
    assert.match(preview.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await browser.newPage();
    const leaks: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith(preview.url)) leaks.push(request.url());
    });
    await page.goto(preview.url);
    assert.match(await page.locator('#safari-untested').textContent() ?? '', /لم يُختبر Safari/);
    const script = await fetch(new URL('popup.js', preview.url));
    assert.equal(script.status, 200);
    assert.match(await script.text(), /missing_chrome/);
    await page.locator('#capture').click();
    assert.equal(await page.locator('#result').textContent(), 'تعذر الحفظ: missing_chrome');
    assert.deepEqual(leaks, []);
    const conversion = JSON.parse(fs.readFileSync(path.join(root, 'app', 'conversion.json'), 'utf8')) as { safariTested: boolean };
    assert.equal(conversion.safariTested, false);
    await page.close();
    await ports.stop(ctx);
    await assert.rejects(fetch(preview.url, { signal: AbortSignal.timeout(1_000) }));
  } finally {
    await browser.close();
    await ports.stop(ctx).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
