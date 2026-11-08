import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const require = createRequire(path.resolve('packages/web/package.json'));
const { chromium } = require('playwright') as {
  chromium: {
    launch(options: { headless: boolean }): Promise<{
      newPage(): Promise<ThemePage>;
      close(): Promise<void>;
    }>;
  };
};

interface ThemePage {
  goto(url: string): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  evaluate(expression: string): Promise<string>;
  close(): Promise<void>;
}

const PAGE = `<!doctype html><html dir="rtl" lang="ar"><meta charset="utf-8"><link rel="stylesheet" href="/tokens.css"><style>button{color:var(--text-primary);background:transparent;}button:focus-visible{outline:2px solid var(--text-primary);outline-offset:2px;}</style><button id="prepare" type="button">تجهيز المشروع</button></html>`;

test('menu text follows the light and dark tokens and a keyboard focus ring', async () => {
  const css = fs.readFileSync(path.resolve('packages/web/src/styles/tokens.css'));
  const hosted = await serve(css);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(hosted.url);
    const light = await read(page);
    assert.equal(light.dir, 'rtl');
    assert.equal(light.lang, 'ar');
    assert.equal(light.color, 'rgb(26, 26, 26)');
    assert.equal(light.text.includes('★'), false);
    await page.keyboard.press('Tab');
    const focused = await read(page);
    assert.equal(focused.active, 'prepare');
    assert.equal(focused.outlineStyle, 'solid');
    assert.equal(focused.outlineColor, 'rgb(26, 26, 26)');
    await page.evaluate('document.documentElement.classList.add("dark")');
    const dark = await read(page);
    assert.equal(dark.color, 'rgb(230, 230, 230)');
    assert.equal(dark.outlineColor, 'rgb(230, 230, 230)');
    await page.evaluate('document.documentElement.dir="ltr"; document.documentElement.lang="en";');
    const english = await read(page);
    assert.equal(english.dir, 'ltr');
    assert.equal(english.lang, 'en');
    assert.equal(english.color, 'rgb(230, 230, 230)');
    await page.close();
  } finally {
    await browser.close();
    await hosted.close();
  }
});

async function read(page: ThemePage): Promise<{ dir: string; lang: string; color: string; outlineStyle: string; outlineColor: string; active: string; text: string }> {
  const raw = await page.evaluate(`JSON.stringify({
    dir: document.documentElement.dir,
    lang: document.documentElement.lang,
    color: getComputedStyle(document.querySelector('#prepare')).color,
    outlineStyle: getComputedStyle(document.querySelector('#prepare')).outlineStyle,
    outlineColor: getComputedStyle(document.querySelector('#prepare')).outlineColor,
    active: document.activeElement ? document.activeElement.id : '',
    text: document.querySelector('#prepare').textContent
  })`);
  return JSON.parse(raw) as { dir: string; lang: string; color: string; outlineStyle: string; outlineColor: string; active: string; text: string };
}

function serve(css: Buffer): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((request, response) => {
    if (request.url === '/tokens.css') {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      response.end(css);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGE);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing port');
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}
