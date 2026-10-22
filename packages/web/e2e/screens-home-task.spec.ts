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

async function mockAuth(page: any) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__apis = {
      auth: {
        getToken: () => 'e2e-token',
        setToken: () => undefined,
        removeToken: () => undefined,
        notifyLoginSuccess: () => undefined,
      },
      system: { openExternal: () => undefined },
      theme: { setTheme: () => undefined },
    };
    w.desktopLocalStorage = {
      getItem: (key: string) => (key === 'session_token' ? 'e2e-token' : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    try {
      window.localStorage.setItem('session_token', 'e2e-token');
    } catch {}
    w.__AGENT_STUDIO_ENV__ = { apiBase: 'http://localhost:8787', socketBase: 'http://localhost:8787' };
  });

  await page.route('**/user.v1.UserService/UserInfo', (route: any) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ firstname: 'E2E', lastname: 'User', displayname: 'E2E User', email: 'e2e@example.com' }),
    }),
  );

  await page.route('**/api/**', (route: any) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    }),
  );
}

test('S2/S3 home in light en', async ({ page }) => {
  await mockAuth(page);
  await page.goto('/app');
  await page.waitForLoadState('networkidle');
  await setTheme(page, 'light');
  await setLocale(page, 'en');
  await page.waitForTimeout(500);
  await take(page, 'light/en/home');
  expect(await page.locator('text=loam').count()).toBeGreaterThan(0);
});

test('S2/S3 home in dark ar', async ({ page }) => {
  await mockAuth(page);
  await page.addInitScript(() => {
    (window as any).__FORCE_LOCALE__ = 'ar';
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
  });
  await page.goto('/app');
  await page.waitForLoadState('networkidle');
  await setTheme(page, 'dark');
  await page.waitForTimeout(500);
  await take(page, 'dark/ar/home');
  expect(await page.locator('text=مهمة جديدة').count()).toBeGreaterThan(0);
});

test('S4 task view running in light en', async ({ page }) => {
  await mockAuth(page);
  await page.goto('/app/demo-running?draft=hello%20world&mode=standard');
  await setTheme(page, 'light');
  await setLocale(page, 'en');
  await page.waitForTimeout(200);
  await take(page, 'light/en/task-running');
});

test('S5 task view completed in light en', async ({ page }) => {
  await mockAuth(page);
  await page.goto('/app/demo-completed?draft=hello%20world&mode=standard');
  await setTheme(page, 'light');
  await setLocale(page, 'en');
  await page.waitForTimeout(1600);
  await take(page, 'light/en/task-completed');
});
