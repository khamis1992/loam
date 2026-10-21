import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// UNIMPLEMENTED_OPTIONS #15 — home promo banner carousel check.
// Serves ui/ with a minimal /api (the carousel needs no backend) and verifies:
// slides and dots render, manual dot navigation works, auto-advance runs and
// resumes after interaction, and prefers-reduced-motion disables both the
// auto-advance and the slide transition.

const modes = [
  { id: 'build', label: 'Loam Build', labelAr: 'ابنِ', tagline: 'من الفكرة إلى تجربة تعمل' },
  { id: 'write', label: 'Loam Write', labelAr: 'اكتب', tagline: 'أفكار تجد صياغتها' },
  { id: 'data', label: 'Loam Data', labelAr: 'حلّل', tagline: 'أرقام تشرح ما يحدث' },
  { id: 'media', label: 'Loam Studio', labelAr: 'صمّم', tagline: 'من الفكرة إلى مشهد حي' },
  { id: 'ask', label: 'Loam Ask', labelAr: 'اسأل', tagline: 'أسئلة واضحة، إجابات موثقة' },
  { id: 'research', label: 'Loam Research', labelAr: 'ابحث', tagline: 'مصادر تقود إلى فهم' },
  { id: 'automate', label: 'Loam Flow', labelAr: 'أنجز', tagline: 'خطوات متكررة، عمل أوضح' },
];
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      let data = {};
      if (url.pathname === '/api/modes') data = { modes };
      if (url.pathname === '/api/settings') data = { theme: 'dark', model: 'fixture' };
      if (url.pathname === '/api/models') data = { models: ['fixture'] };
      if (url.pathname === '/api/tasks') data = { tasks: [] };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(data));
      return;
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (file.includes('..')) throw new Error('bad path');
    const content = await readFile(new URL('../../ui/' + file, import.meta.url));
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
    res.end(content);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const activeHref = page => page.locator('#promoCarousel .promo-slide.is-active').getAttribute('href');
try {
  // Default motion: slides render, auto-advance runs, manual dots switch immediately.
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin);
    await page.locator('#promoCarousel .promo-slide').first().waitFor();
    assert.equal(await page.locator('#promoCarousel .promo-slide').count(), 2, 'two slides render');
    assert.equal(await page.locator('#promoCarousel .promo-dot').count(), 2, 'one dot per slide');
    assert.equal(await page.locator('#promoCarousel .promo-slide').first().getAttribute('href'), '#/modes/build');
    assert.equal(await page.locator('#promoCarousel .promo-slide').nth(1).getAttribute('href'), '#/modes/media');
    assert.equal(await page.locator('#promoCarousel .promo-slide-badge').first().textContent(), 'BUILD AN APP');
    assert.equal(await page.locator('#promoCarousel .promo-slide-badge').nth(1).textContent(), 'CREATE YOUR VIDEO');
    assert.equal(await activeHref(page), '#/modes/build', 'first slide starts active');
    // Auto-advance moves to the next slide after the interval (no interaction yet).
    await page.waitForTimeout(7000);
    assert.equal(await activeHref(page), '#/modes/media', 'auto-advance must move to the next slide');
    // Manual dots switch immediately.
    await page.locator('#promoCarousel .promo-dot').first().click();
    assert.equal(await activeHref(page), '#/modes/build', 'manual dot switches back to slide one');
    // After the interaction ends (blur + mouse away), auto-advance resumes.
    await page.locator('#promoCarousel .promo-dot').first().evaluate(el => el.blur());
    await page.mouse.move(700, 500);
    await page.waitForTimeout(7000);
    assert.equal(await activeHref(page), '#/modes/media', 'auto-advance must resume after interaction');
    assert.deepEqual(errors, []);
    // The banner must not overflow the home view at narrow widths, in both directions.
    for (const width of [1440, 768, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const dir of ['rtl', 'ltr']) {
        await page.evaluate(dir => { document.documentElement.dir = dir; }, dir);
        const over = await page.evaluate(() => {
          const view = document.querySelector('.view.active');
          return view.scrollWidth > view.clientWidth + 1;
        });
        assert.equal(over, false, `home overflow at ${width}px ${dir}`);
      }
    }
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    await page.close();
  }
  // Reduced motion: no auto-advance and no slide transition; dots stay manual.
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin);
    await page.locator('#promoCarousel .promo-slide').first().waitFor();
    await page.waitForTimeout(7000);
    assert.equal(await activeHref(page), '#/modes/build', 'reduced motion must not auto-advance');
    const transition = await page.locator('#promoCarousel .promo-slide').first().evaluate(el => getComputedStyle(el).transitionProperty);
    assert.equal(transition, 'none', 'reduced motion must disable the slide transition');
    await page.locator('#promoCarousel .promo-dot').nth(1).click();
    assert.equal(await activeHref(page), '#/modes/media', 'manual dots keep working under reduced motion');
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('promo carousel check passed');
} finally {
  await browser.close();
  server.close();
}
