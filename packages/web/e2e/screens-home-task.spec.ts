import { test, expect } from '@playwright/test';

const snapshot = (name: string) => `../tests/visual/baselines/${name}.png`;

async function setTheme(page: any, theme: 'light' | 'dark') {
  await page.evaluate((t: string) => {
    const html = document.documentElement;
    html.classList.remove('light', 'dark');
    html.classList.add(t);
  }, theme);
}

async function setLocale(page: any, locale: 'en' | 'ar') {
  await page.evaluate((l: string) => {
    const html = document.documentElement;
    html.lang = l;
    html.dir = l === 'ar' ? 'rtl' : 'ltr';
    (window as any).__FORCE_LOCALE__ = l;
  }, locale);
}

async function take(page: any, name: string) {
  await page.screenshot({ path: snapshot(name), fullPage: false });
}

test('S2/S3 home in light en', async ({ page }) => {
  await page.goto('/app/');
  await page.waitForLoadState('networkidle');
  await setTheme(page, 'light');
  await setLocale(page, 'en');
  await page.waitForTimeout(500);
  await take(page, 'light/en/home');
  expect(await page.locator('text=Agent Studio 2.0').count()).toBeGreaterThan(0);
});

test('S2/S3 home in dark ar', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__FORCE_LOCALE__ = 'ar';
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
  });
  await page.goto('/app/');
  await page.waitForLoadState('networkidle');
  await setTheme(page, 'dark');
  await page.waitForTimeout(500);
  await take(page, 'dark/ar/home');
  expect(await page.locator('text=مهمة جديدة').count()).toBeGreaterThan(0);
});

test('S4 task view running in light en', async ({ page }) => {
  await page.goto('/app/demo-running/?draft=hello%20world&mode=standard');
  await setTheme(page, 'light');
  await setLocale(page, 'en');
  await page.waitForTimeout(200);
  await take(page, 'light/en/task-running');
});

test('S5 task view completed in light en', async ({ page }) => {
  await page.goto('/app/demo-completed/?draft=hello%20world&mode=standard');
  await setTheme(page, 'light');
  await setLocale(page, 'en');
  await page.waitForTimeout(1600);
  await take(page, 'light/en/task-completed');
});
