import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { gameDocument } from '../games/page.js';

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
  locator(selector: string): { focus(): Promise<void> };
  evaluate<T>(fn: (() => T) | string): Promise<T>;
  keyboard: { down(key: string): Promise<void>; up(key: string): Promise<void>; press(key: string): Promise<void>; type(text: string): Promise<void> };
  waitForFunction(fn: (() => boolean) | string, arg: undefined, options: { timeout: number }): Promise<void>;
  on(event: 'request', handler: (request: { url(): string }) => void): void;
}

test('the canvas game responds to the keyboard in a browser', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const external: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('data:') && !url.startsWith('about:')) external.push(url);
  });
  try {
    await page.setContent(gameDocument());
    await page.waitForFunction(() => typeof (window as unknown as { __x?: number }).__x === 'number', undefined, { timeout: 2_000 });
    await page.locator('#speed').focus();
    const held = await page.evaluate(() => (window as unknown as { __x: number }).__x);
    await page.keyboard.press('ArrowRight');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await page.evaluate(() => (window as unknown as { __x: number }).__x), held);
    await page.locator('canvas').focus();
    await page.keyboard.down('ArrowRight');
    await page.keyboard.down('Space');
    await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('WIN') === true, undefined, { timeout: 8_000 });
    await page.keyboard.up('Space');
    await page.keyboard.up('ArrowRight');
    await page.keyboard.press('r');
    await page.waitForFunction(() => document.getElementById('status')?.textContent === '', undefined, { timeout: 2_000 });
    await page.keyboard.down('ArrowRight');
    await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('LOSE') === true, undefined, { timeout: 8_000 });
    await page.keyboard.press('r');
    await page.waitForFunction(() => (window as unknown as { __x: number }).__x < 100, undefined, { timeout: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stayed = await page.evaluate(() => (window as unknown as { __x: number }).__x);
    assert.equal(stayed < 120, true);
    await page.keyboard.up('ArrowRight');
    await page.keyboard.down('ArrowRight');
    await page.waitForFunction(() => (window as unknown as { __x: number }).__x > 160, undefined, { timeout: 2_000 });
    await page.keyboard.up('ArrowRight');
    assert.deepEqual(external, []);
  } finally {
    await browser.close();
  }
});

test('game keys stay inside the frame and text fields keep their letters', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent('<!doctype html><textarea id="note"></textarea><iframe id="game"></iframe>');
    await page.evaluate(`document.querySelector('#game').srcdoc = ${JSON.stringify(gameDocument())}`);
    await page.waitForFunction("() => { const frame = document.querySelector('#game'); return Boolean(frame && frame.contentWindow && typeof frame.contentWindow.__x === 'number'); }", undefined, { timeout: 2_000 });
    const started = await page.evaluate<number>("document.querySelector('#game').contentWindow.__x");
    await page.evaluate("const frame = document.querySelector('#game').contentWindow; frame.__blocked = 0; frame.addEventListener('keydown', function(event){ if(event.defaultPrevented) frame.__blocked += 1; });");
    await page.locator('#note').focus();
    await page.keyboard.type('خميس');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate("document.querySelector('#note').value"), 'خميس');
    assert.equal(await page.evaluate<number>("document.querySelector('#game').contentWindow.__blocked"), 0);
    assert.equal(await page.evaluate<number>("document.querySelector('#game').contentWindow.__x"), started);
    await page.evaluate("document.querySelector('#game').contentDocument.querySelector('canvas').focus()");
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate<number>("document.querySelector('#game').contentWindow.__blocked") > 0, true);
    await page.waitForFunction("() => document.querySelector('#game').contentWindow.__x > 100", undefined, { timeout: 2_000 });
    assert.equal(await page.evaluate("document.querySelector('#game').contentDocument.querySelector('#status').getAttribute('aria-live')"), 'polite');
    assert.match(await page.evaluate<string>("document.querySelector('#game').contentDocument.body.textContent"), /الأسهم للحركة/);
  } finally {
    await browser.close();
  }
});
