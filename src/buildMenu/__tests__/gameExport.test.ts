import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { createGamesPorts } from '../games/ports.js';
import { ProcessLeaseRegistry } from '../processLease.js';

const require = createRequire(path.resolve('packages/web/package.json'));
const { chromium } = require('playwright') as {
  chromium: {
    launch(options: { headless: boolean }): Promise<{
      newPage(): Promise<GamePage>;
      close(): Promise<void>;
    }>;
  };
};

interface GamePage {
  goto(url: string): Promise<unknown>;
  reload(): Promise<void>;
  keyboard: { down(key: string): Promise<void>; up(key: string): Promise<void>; press(key: string): Promise<void> };
  locator(selector: string, options?: { hasText: string }): { click(): Promise<void>; waitFor(options: { timeout: number }): Promise<void>; textContent(): Promise<string | null>; fill(value: string): Promise<void>; inputValue(): Promise<string> };
  evaluate<T>(expression: string | (() => T)): Promise<T>;
  context(): { setOffline(offline: boolean): Promise<void> };
  on(event: 'request', handler: (request: { url(): string }) => void): void;
}

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'game' };
  return {
    workspace,
    jobId: 'job_game_export',
    operation: { action: 'package', format: 'web-zip' },
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

test('the game bundle plays offline and restarts do not add listeners', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-game-zip-'));
  const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-game-host-'));
  const ports = createGamesPorts({ leases: new ProcessLeaseRegistry(500) });
  const ctx = context(root);
  const browser = await chromium.launch({ headless: true });
  let closeServer: (() => Promise<void>) | undefined;
  try {
    await ports.scaffold(ctx);
    const web = await ports.export(ctx, 'web-zip');
    const source = await ports.export({ ...ctx, operation: { action: 'package', format: 'source-zip' } }, 'source-zip');
    const webFiles = unzip(fs.readFileSync(path.join(root, web.relativePath)));
    const sourceFiles = unzip(fs.readFileSync(path.join(root, source.relativePath)));
    assert.deepEqual([...webFiles.keys()].sort(), ['LICENSE', 'assets/manifest.json', 'index.html', 'tuning.json']);
    for (const name of ['LICENSE', 'assets/manifest.json', 'index.html', 'tuning.json']) assert.equal(sourceFiles.has(name), true);
    const manifest = JSON.parse(webFiles.get('assets/manifest.json')?.toString('utf8') ?? '') as { assets: Array<{ path: string; source: string; license: string; evidenceSha256: string }> };
    for (const asset of manifest.assets) {
      assert.equal(asset.source, 'local-geometry');
      assert.equal(asset.license, 'local');
      const body = webFiles.get(asset.path);
      assert.ok(body);
      assert.equal(createHash('sha256').update(body).digest('hex'), asset.evidenceSha256);
      assert.equal(/https?:\/\//i.test(body.toString('utf8')), false);
    }
    for (const [name, body] of webFiles) {
      fs.mkdirSync(path.dirname(path.join(unpacked, name)), { recursive: true });
      fs.writeFileSync(path.join(unpacked, name), body);
    }
    const hosted = await serve(unpacked);
    closeServer = hosted.close;
    const page = await browser.newPage();
    const external: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith(hosted.url)) external.push(request.url());
    });
    await page.goto(hosted.url);
    await page.locator('canvas').click();
    const listeners = await page.evaluate(() => (window as unknown as { __listeners: number }).__listeners);
    assert.equal(listeners, 5);
    for (let time = 0; time < 10; time += 1) await page.keyboard.press('r');
    assert.equal(await page.evaluate(() => (window as unknown as { __listeners: number }).__listeners), listeners);
    let framesBefore = 0;
    for (let attempt = 0; attempt < 20 && framesBefore === 0; attempt += 1) {
      framesBefore = await page.evaluate<number>('window.__frames');
      if (framesBefore === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(framesBefore > 0);
    await page.evaluate('window.dispatchEvent(new Event("pagehide"))');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(await page.evaluate<number>('window.__frames'), framesBefore);
    await page.reload();
    await page.locator('canvas').click();
    const start = await page.evaluate(() => (window as unknown as { __x: number }).__x);
    await page.keyboard.down('ArrowRight');
    let moved = start;
    for (let attempt = 0; attempt < 40 && moved === start; attempt += 1) {
      moved = await page.evaluate(() => (window as unknown as { __x: number }).__x);
      if (moved === start) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await page.keyboard.up('ArrowRight');
    assert.ok(moved > start);
    await page.keyboard.press('r');
    await page.context().setOffline(true);
    await page.keyboard.down('ArrowRight');
    await page.keyboard.down('Space');
    await page.locator('#status', { hasText: 'WIN' }).waitFor({ timeout: 8_000 });
    assert.deepEqual(external, []);
  } finally {
    await browser.close();
    if (closeServer) await closeServer();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(unpacked, { recursive: true, force: true });
  }
});

test('a near goal in the bundle is won on foot and a far goal is lost', async () => {
  const browser = await chromium.launch({ headless: true });
  const cases = [
    { brief: 'هدف قريب\n', goal: 420, label: 'هدف قريب', status: 'WIN' },
    { brief: 'هدف بعيد\n', goal: 600, label: 'هدف بعيد', status: 'LOSE' },
  ] as const;
  try {
    for (const item of cases) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-game-goal-'));
      const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-game-goal-host-'));
      const ports = createGamesPorts({ leases: new ProcessLeaseRegistry(500) });
      const ctx = context(root);
      let closeServer: (() => Promise<void>) | undefined;
      try {
        fs.mkdirSync(path.join(root, 'app'), { recursive: true });
        fs.writeFileSync(path.join(root, 'app', 'brief.txt'), item.brief);
        await ports.scaffold(ctx);
        const web = await ports.export(ctx, 'web-zip');
        const files = unzip(fs.readFileSync(path.join(root, web.relativePath)));
        const html = files.get('index.html')?.toString('utf8') ?? '';
        assert.equal(html.includes(`const GOAL=${item.goal}`), true);
        assert.match(html, /id="engine-note">هذه لعبة لوحة محلية\. لم يُثبَّت محرك ألعاب\./);
        assert.match(html, new RegExp(`id="scene">${item.label}`));
        assert.equal(/https?:\/\//i.test(html), false);
        for (const [name, body] of files) {
          fs.mkdirSync(path.dirname(path.join(unpacked, name)), { recursive: true });
          fs.writeFileSync(path.join(unpacked, name), body);
        }
        const hosted = await serve(unpacked);
        closeServer = hosted.close;
        const page = await browser.newPage();
        const external: string[] = [];
        page.on('request', (request) => {
          if (!request.url().startsWith(hosted.url)) external.push(request.url());
        });
        await page.goto(hosted.url);
        assert.equal(await page.locator('#engine-note').textContent(), 'هذه لعبة لوحة محلية. لم يُثبَّت محرك ألعاب.');
        await page.locator('canvas').click();
        await page.context().setOffline(true);
        await page.keyboard.down('ArrowRight');
        await page.locator('#status', { hasText: item.status }).waitFor({ timeout: 8_000 });
        await page.keyboard.up('ArrowRight');
        assert.deepEqual(external, []);
        await page.close();
      } finally {
        if (closeServer) await closeServer();
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(unpacked, { recursive: true, force: true });
      }
    }
  } finally {
    await browser.close();
  }
});

test('the unpacked game keeps a tuning change without this app', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-game-tune-'));
  const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-game-tune-host-'));
  const ports = createGamesPorts({ leases: new ProcessLeaseRegistry(500) });
  const ctx = context(root);
  const browser = await chromium.launch({ headless: true });
  let closeServer: (() => Promise<void>) | undefined;
  try {
    await ports.scaffold(ctx);
    const web = await ports.export(ctx, 'web-zip');
    const files = unzip(fs.readFileSync(path.join(root, web.relativePath)));
    const original = files.get('tuning.json')?.toString('utf8') ?? '';
    assert.match(original, /"speed":200/);
    for (const [name, body] of files) {
      fs.mkdirSync(path.dirname(path.join(unpacked, name)), { recursive: true });
      fs.writeFileSync(path.join(unpacked, name), body);
    }
    const hosted = await serve(unpacked);
    closeServer = hosted.close;
    const page = await browser.newPage();
    const external: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith(hosted.url)) external.push(request.url());
    });
    await page.goto(hosted.url);
    await page.locator('#speed').fill('80');
    await page.reload();
    let restored = '';
    for (let attempt = 0; attempt < 40 && restored !== '80'; attempt += 1) {
      restored = await page.locator('#speed').inputValue();
      if (restored !== '80') await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(restored, '80');
    assert.equal(fs.readFileSync(path.join(unpacked, 'tuning.json'), 'utf8'), original);
    await page.evaluate('localStorage.setItem("loam-game-tuning","{bad")');
    await page.reload();
    let fallback = '';
    for (let attempt = 0; attempt < 40 && fallback !== '200'; attempt += 1) {
      fallback = await page.locator('#speed').inputValue();
      if (fallback !== '200') await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(fallback, '200');
    assert.deepEqual(external, []);
  } finally {
    await browser.close();
    if (closeServer) await closeServer();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(unpacked, { recursive: true, force: true });
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

function serve(dir: string): Promise<{ url: string; close(): Promise<void> }> {
  const root = path.resolve(dir);
  const server = http.createServer((request, response) => {
    const name = (request.url ?? '/').split('?')[0] ?? '/';
    const relative = name === '/' ? 'index.html' : name.replace(/^\/+/, '');
    const absolute = path.resolve(root, ...relative.split('/'));
    if (relative.includes('..') || !absolute.startsWith(root) || !fs.existsSync(absolute) || fs.lstatSync(absolute).isSymbolicLink()) {
      response.writeHead(404, { 'x-content-type-options': 'nosniff' });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' });
    response.end(fs.readFileSync(absolute));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
