import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3456',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 840 } } },
  ],
  webServer: {
    command: 'npx http-server dist -p 3456 -c-1',
    url: 'http://localhost:3456',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
