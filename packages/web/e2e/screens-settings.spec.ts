import { test, expect } from '@playwright/test';

test.describe('A5 settings screens', () => {
  test('settings dialog renders all MVP tabs', async ({ page }) => {
    await page.goto('/login');
    await page.waitForFunction(() => typeof (window as any).__testOpenSettings === 'function');
    await page.evaluate(() => {
      (window as any).__testOpenSettings?.();
    });
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    for (const tab of ['General', 'Account', 'Appearance', 'Data controls', 'My Computer', 'Usage']) {
      await page.getByRole('button', { name: tab }).click();
      await expect(page.locator('main h2').filter({ hasText: tab })).toBeVisible();
    }
  });

  test('my computer pane lists folders and supports remove', async ({ page }) => {
    await page.goto('/login');
    await page.waitForFunction(() => typeof (window as any).__testOpenSettings === 'function');
    await page.evaluate(() => (window as any).__testOpenSettings?.('My Computer'));
    await expect(page.getByText('Add folders for quick access when starting tasks on this computer.')).toBeVisible();
    await expect(page.getByText('~/Documents/reports')).toBeVisible();
    await page.getByRole('button', { name: 'Remove folder' }).first().click();
    await expect(page.getByText('~/Documents/reports')).not.toBeVisible();
  });

  test('login screen renders and shows sign in', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: /Sign in/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    await expect(page.getByText('Terms of Service')).toBeVisible();
  });

  test('activity indicator page renders transparent panel', async ({ page }) => {
    await page.goto('/desktop-activity-indicator');
    await expect(page.getByText('Summarize the quarterly report')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop task' })).toBeVisible();
  });
});
