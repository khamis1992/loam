import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  setContent(html: string): Promise<void>;
  on(event: 'request', handler: (request: { url(): string }) => void): void;
  keyboard: { down(key: string): Promise<void>; up(key: string): Promise<void>; press(key: string): Promise<void> };
  frameLocator(selector: string): {
    locator(selector: string, options?: { hasText: string }): {
      click(): Promise<void>;
      fill(value: string): Promise<void>;
      inputValue(): Promise<string>;
      textContent(): Promise<string | null>;
      waitFor(options: { timeout: number }): Promise<void>;
    };
  };
  locator(selector: string): {
    inputValue(): Promise<string>;
    click(): Promise<void>;
    fill(value: string): Promise<void>;
    evaluate(fn: (node: unknown, next: string) => void, next: string): Promise<void>;
  };
  frames(): Array<{ url(): string; evaluate<T>(fn: () => T): Promise<T> }>;
}

function context(workspace: string): BuildJobContext {
  const selection: BuildManifest['selection'] = { kind: 'game' };
  return {
    workspace,
    jobId: 'job_game_preview',
    operation: { action: 'preview' },
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

test('a tuning save refuses a temp path that is not a file and keeps the saved tuning', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-game-tuning-'));
  const leases = new ProcessLeaseRegistry(500);
  const ports = createGamesPorts({ leases });
  const ctx = context(root);
  ctx.jobId = 'job_game_tuning';
  try {
    await ports.scaffold(ctx);
    const preview = await ports.preview(ctx);
    assert.equal(preview.kind, 'http');
    if (preview.kind !== 'http') return;
    const tuningPath = path.join(root, 'app', 'tuning.json');
    const before = fs.readFileSync(tuningPath, 'utf8');
    const temp = `${tuningPath}.tmp`;
    fs.mkdirSync(temp);
    const blocked = await fetch(`${preview.url}tuning`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"speed":90,"gravity":700}',
    });
    assert.equal(blocked.status, 400);
    assert.equal(fs.readFileSync(tuningPath, 'utf8'), before);
    assert.equal(fs.statSync(temp).isDirectory(), true);
    fs.rmSync(temp, { recursive: true });
    fs.writeFileSync(temp, 'stale\n');
    const saved = await fetch(`${preview.url}tuning`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"speed":90,"gravity":700}',
    });
    assert.equal(saved.status, 204);
    assert.equal(fs.readFileSync(tuningPath, 'utf8'), '{"speed":90,"gravity":700}\n');
    assert.equal(fs.existsSync(temp), false);
  } finally {
    await ports.stop(ctx).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the preview refuses a page that is no longer a regular file and stays up', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-game-page-'));
  const leases = new ProcessLeaseRegistry(500);
  const ports = createGamesPorts({ leases });
  const ctx = context(root);
  ctx.jobId = 'job_game_page';
  try {
    await ports.scaffold(ctx);
    const preview = await ports.preview(ctx);
    assert.equal(preview.kind, 'http');
    if (preview.kind !== 'http') return;
    const page = path.join(root, 'app', 'index.html');
    const copy = fs.readFileSync(page);
    fs.rmSync(page);
    fs.mkdirSync(page);
    const blocked = await fetch(preview.url);
    assert.equal(blocked.status, 400);
    fs.rmSync(page, { recursive: true });
    fs.writeFileSync(page, copy);
    const again = await fetch(preview.url);
    assert.equal(again.status, 200);
    assert.match(await again.text(), /<canvas/);
  } finally {
    await ports.stop(ctx).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the preview iframe plays, saves tuning, and stops on page hide', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-game-'));
  const leases = new ProcessLeaseRegistry(500);
  const ports = createGamesPorts({ leases });
  const ctx = context(root);
  const browser = await chromium.launch({ headless: true });
  try {
    await ports.scaffold(ctx);
    const preview = await ports.preview(ctx);
    assert.equal(preview.kind, 'http');
    if (preview.kind !== 'http') return;
    const tuningPath = path.join(root, 'app', 'tuning.json');
    const before = fs.readFileSync(tuningPath, 'utf8');
    const rejected = await fetch(`${preview.url}tuning`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"speed":1,"gravity":700}',
    });
    assert.equal(rejected.status, 400);
    assert.equal(fs.readFileSync(tuningPath, 'utf8'), before);

    const page = await browser.newPage();
    const external: string[] = [];
    page.on('request', (request: { url(): string }) => {
      const url = request.url();
      if (!url.startsWith(preview.url) && !url.startsWith('data:') && !url.startsWith('about:')) external.push(url);
    });
    await page.setContent(`<input id="note"><iframe sandbox="allow-scripts allow-same-origin" src="${preview.url}"></iframe>`);
    const frame = page.frameLocator('iframe');
    await frame.locator('canvas').click();
    await page.keyboard.down('ArrowRight');
    await page.keyboard.down('Space');
    await frame.locator('#status', { hasText: 'WIN' }).waitFor({ timeout: 8_000 });
    await page.keyboard.up('Space');
    await page.keyboard.up('ArrowRight');
    await page.keyboard.press('r');
    let cleared = 'WIN';
    for (let attempt = 0; attempt < 40 && cleared !== ''; attempt += 1) {
      cleared = await frame.locator('#status').textContent() ?? 'WIN';
      if (cleared !== '') await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(cleared, '');
    const playingNow = page.frames().find((item) => item.url().startsWith(preview.url));
    assert.ok(playingNow);
    await page.locator('#note').click();
    const held = await playingNow.evaluate(() => (window as unknown as { __x: number }).__x);
    await page.keyboard.down('ArrowRight');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.keyboard.up('ArrowRight');
    assert.equal(await playingNow.evaluate(() => (window as unknown as { __x: number }).__x), held);
    await page.locator('#note').fill('ملاحظة');
    assert.equal(await page.locator('#note').inputValue(), 'ملاحظة');

    await frame.locator('canvas').click();
    await frame.locator('#speed').fill('80');
    const saved = await readSaved(tuningPath);
    assert.equal(saved, '{"speed":80,"gravity":700}\n');
    await page.locator('iframe').evaluate((node, next) => {
      (node as { src: string }).src = String(next);
    }, `${preview.url}?reload=1`);
    let restored = '';
    for (let attempt = 0; attempt < 40 && restored !== '80'; attempt += 1) {
      restored = await frame.locator('#speed').inputValue().catch(() => '');
      if (restored !== '80') await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(restored, '80');

    const playing = page.frames().find((item) => item.url().startsWith(preview.url));
    assert.ok(playing);
    const framesBefore = await playing.evaluate(() => (window as unknown as { __frames: number }).__frames);
    await playing.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const framesAfter = await playing.evaluate(() => (window as unknown as { __frames: number }).__frames);
    assert.equal(framesAfter, framesBefore);
    assert.deepEqual(external, []);
  } finally {
    await browser.close();
    await ports.stop(ctx).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function readSaved(tuningPath: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const text = fs.readFileSync(tuningPath, 'utf8');
    if (text.includes('"speed":80')) return text;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fs.readFileSync(tuningPath, 'utf8');
}
