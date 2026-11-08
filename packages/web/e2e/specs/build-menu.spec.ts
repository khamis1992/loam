/**
 * Build menu visual contract. Every /api call is mocked. A green run proves
 * the page layout and the grant click path only; it does not prove a native
 * engine, a portable executable, a notebook kernel, or a device build.
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const PREPARED = {
  projectId: 'app_e2etestbuild',
  revision: 1,
  jobId: 'job_00000000-0000-4000-8000-000000000001',
  engine: 'loam-build',
  summary: 'home',
  previewHtml: '<p>متجر</p>',
};

async function installSession(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const host = window as unknown as Record<string, unknown>;
    host.__apis = {
      auth: { getToken: () => 'e2e-token', setToken: () => undefined, removeToken: () => undefined, notifyLoginSuccess: () => undefined },
      system: { openExternal: () => undefined },
      theme: { setTheme: () => undefined },
    };
    host.desktopLocalStorage = {
      getItem: (key: string) => (key === 'session_token' ? 'e2e-token' : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    try { window.localStorage.setItem('session_token', 'e2e-token'); } catch { /* static page storage */ }
  });
  await page.route('**/user.v1.UserService/UserInfo', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ firstname: 'E2E', lastname: 'User', displayname: 'E2E User', email: 'e2e@example.com' }),
  }));
  await page.route('**/api/app-projects**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ projects: [] }),
  }));
  await page.route('**/api/sessions/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '[]',
  }));
  await page.route('**/api/config', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ model: 'm', workspace: 'C:/tmp', modes: [] }),
  }));
}

function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

test.describe('build menu visual contract', () => {
  test.setTimeout(90_000);

  test('a disabled menu stays on the previous path and posts no job', async ({ page }) => {
    await installSession(page);
    let jobs = 0;
    await page.route('**/api/build-menu/**', (route) => {
      if (route.request().url().includes('/jobs')) jobs += 1;
      return json(route, 200, { enabled: false });
    });
    await page.goto('/app/build');
    await expect(page.getByTestId('build-brief')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose websites' })).toHaveCount(0);
    expect(jobs).toBe(0);
  });

  test('nine choices, four website subtypes, one grant, and a refused export', async ({ page }) => {
    await installSession(page);
    let grants = 0;
    let jobs = 0;
    await page.route('**/api/build-menu/**', (route) => {
      const url = route.request().url();
      if (url.endsWith('/capabilities')) return json(route, 200, { enabled: true });
      if (url.endsWith('/projects')) return json(route, 200, { projectId: PREPARED.projectId, revision: PREPARED.revision });
      if (url.endsWith('/grants')) {
        grants += 1;
        return json(route, 200, { grantId: 'grant_e2e' });
      }
      if (url.endsWith('/jobs')) {
        jobs += 1;
        const operation = route.request().postDataJSON() as { operation?: { action?: string } };
        if (operation.operation?.action === 'package') return json(route, 400, { error: 'missing_requirement' });
        return json(route, 200, PREPARED);
      }
      return json(route, 404, { error: 'not_found' });
    });

    await page.goto('/app/build');
    const dialog = page.getByRole('dialog', { name: 'Choose a build kind' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Choose / })).toHaveCount(9);
    await expect(page.locator('main svg.lucide-sparkles, main svg.lucide-star')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('build-brief')).toBeVisible();
    expect(jobs).toBe(0);

    await page.goto('/app/build');
    const again = page.getByRole('dialog', { name: 'Choose a build kind' });
    await expect(again).toBeVisible();
    await again.getByRole('button', { name: 'Choose websites' }).click();
    await expect(page.getByRole('button', { name: 'Chatbot' })).toBeVisible();
    await page.getByRole('tab', { name: 'Landing Page' }).click();
    await expect(page.getByTestId('website-template-solar-company')).toBeVisible();
    await page.getByRole('tab', { name: 'E-commerce' }).click();
    await expect(page.getByTestId('website-template-merch-store')).toBeVisible();
    await page.getByRole('tab', { name: 'SaaS' }).click();
    await expect(page.getByTestId('website-template-online-booking')).toBeVisible();
    await page.getByRole('button', { name: 'Chatbot' }).click();
    await expect(page.getByTestId('build-menu-brief')).toHaveValue('Build a local chatbot that answers inside the page');
    await page.locator('main').getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('button', { name: /^Choose / })).toHaveCount(9);
    expect(jobs).toBe(0);

    await page.getByRole('button', { name: 'Choose Desktop app' }).click();
    await page.getByTestId('build-menu-brief').fill('Build a local desktop organizer');
    await page.getByRole('button', { name: 'Prepare the project' }).click();
    await expect(page.getByText('loam-build: home')).toBeVisible();
    expect(grants).toBe(1);
    expect(jobs).toBe(1);

    await page.getByRole('button', { name: 'Export source' }).click();
    await expect(page.locator('main p[role="alert"]')).toHaveText('missing_requirement');
    await expect(page.getByText(PREPARED.jobId)).toHaveCount(0);
    expect(grants).toBe(2);
  });

  test('a denied grant shows the error and no prepared project', async ({ page }) => {
    await installSession(page);
    let jobs = 0;
    await page.route('**/api/build-menu/**', (route) => {
      const url = route.request().url();
      if (url.endsWith('/capabilities')) return json(route, 200, { enabled: true });
      if (url.endsWith('/projects')) return json(route, 200, { projectId: PREPARED.projectId, revision: PREPARED.revision });
      if (url.endsWith('/grants')) return json(route, 403, { error: 'forbidden' });
      if (url.endsWith('/jobs')) jobs += 1;
      return json(route, 404, { error: 'not_found' });
    });
    await page.goto('/app/build');
    await expect(page.getByRole('dialog', { name: 'Choose a build kind' })).toBeVisible();
    await page.getByRole('button', { name: 'Choose Desktop app' }).click();
    await page.getByTestId('build-menu-brief').fill('Build a local desktop organizer');
    await page.getByRole('button', { name: 'Prepare the project' }).click();
    await expect(page.locator('main p[role="alert"]')).toHaveText('forbidden');
    await expect(page.getByText('loam-build: home')).toHaveCount(0);
    expect(jobs).toBe(0);
  });

  test('english and arabic keep direction, theme, and keyboard focus inside the dialog', async ({ page }) => {
    await page.addInitScript(() => {
      if (!window.localStorage.getItem('agent-studio:locale')) window.localStorage.setItem('agent-studio:locale', 'en');
      if (!window.localStorage.getItem('agent-studio:theme')) window.localStorage.setItem('agent-studio:theme', 'light');
    });
    await installSession(page);
    let jobs = 0;
    await page.route('**/api/build-menu/**', (route) => {
      if (route.request().url().includes('/jobs')) jobs += 1;
      return json(route, 200, { enabled: true });
    });
    await page.goto('/app/build');
    const dialog = page.getByRole('dialog', { name: 'Choose a build kind' });
    await expect(dialog).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).toHaveClass(/light/);
    await expect(dialog.getByRole('button', { name: /^Choose / })).toHaveCount(9);
    await expect(page.locator('main svg.lucide-sparkles, main svg.lucide-star')).toHaveCount(0);
    const light = await page.locator('html').evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(light).toBe('rgb(248, 248, 247)');
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
    for (let step = 0; step < 10; step += 1) {
      await page.keyboard.press('Tab');
      await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    }
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Choose Game development' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('build-brief')).toBeVisible();
    expect(jobs).toBe(0);

    await page.evaluate(() => {
      window.localStorage.setItem('agent-studio:locale', 'ar');
      window.localStorage.setItem('agent-studio:theme', 'dark');
    });
    await page.reload();
    const arabic = page.getByRole('dialog', { name: 'اختر نوع البناء' });
    await expect(arabic).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(arabic.getByRole('button', { name: /^اختر / })).toHaveCount(9);
    await expect(page.locator('main svg.lucide-sparkles, main svg.lucide-star')).toHaveCount(0);
    const dark = await page.locator('html').evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(dark).toBe('rgb(26, 26, 26)');
    await expect(arabic.getByRole('button', { name: 'إغلاق' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect.poll(() => arabic.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('build-brief')).toBeVisible();
    expect(jobs).toBe(0);
  });

  test('arabic labels keep direction and a focused close control', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('agent-studio:locale', 'ar');
    });
    await installSession(page);
    await page.route('**/api/build-menu/**', (route) => json(route, 200, { enabled: true }));
    await page.goto('/app/build');
    const dialog = page.getByRole('dialog', { name: 'اختر نوع البناء' });
    await expect(dialog).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(dialog.getByRole('button', { name: /^اختر / })).toHaveCount(9);
    const close = dialog.getByRole('button', { name: 'إغلاق' });
    await close.focus();
    await expect(close).toBeFocused();
  });

  test('automation activation is a separate click after prepare', async ({ page }) => {
    await installSession(page);
    const calls: string[] = [];
    await page.route('**/api/build-menu/**', (route) => {
      const url = route.request().url();
      calls.push(`${route.request().method()} ${url}`);
      if (url.endsWith('/capabilities')) return json(route, 200, { enabled: true });
      if (url.endsWith('/projects')) return json(route, 200, { projectId: PREPARED.projectId, revision: PREPARED.revision });
      if (url.endsWith('/grants')) return json(route, 200, { grantId: 'grant_e2e' });
      if (url.endsWith('/jobs')) return json(route, 200, { ...PREPARED, engine: 'loam-schedule', summary: 'schedule' });
      if (url.endsWith('/routines/activate')) return json(route, 200, { enabled: true });
      if (url.endsWith('/routines/disable')) return json(route, 200, { enabled: false });
      return json(route, 404, { error: 'not_found' });
    });
    await page.goto('/app/build');
    await page.getByRole('button', { name: 'Choose Automations' }).click();
    await page.getByTestId('build-menu-brief').fill('Prepare a local Monday report and do not send it');
    await page.getByRole('button', { name: 'Prepare the project' }).click();
    await page.getByRole('button', { name: 'Activate local reports' }).click();
    await expect(page.getByTestId('build-routine-state')).toHaveText('Local reports are on');
    await page.getByRole('button', { name: 'Disable local reports' }).click();
    await expect(page.getByTestId('build-routine-state')).toHaveText('Local reports are off');
    expect(calls.filter((call) => call.includes('/routines/activate'))).toHaveLength(1);
    expect(calls.filter((call) => call.includes('/routines/disable'))).toHaveLength(1);
    expect(calls.filter((call) => call.includes('/jobs'))).toHaveLength(1);
  });
});
