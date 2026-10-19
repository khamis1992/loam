import { test, expect, simulateDeepLink } from "../harness/fixtures.js";

test.describe("login flow §9.1", () => {
  test("sign in via deep link lands on /app", async ({ app, page }) => {
    await page.goto("app://agent/login");
    await expect(page.locator("text=Sign in to")).toBeVisible({ timeout: 10_000 });

    const nonce = "n-test-123";
    const loginToken = "lt-test-123";
    const webBase = process.env.WEB_LOGIN_BASE ?? "http://localhost:8787";
    const callback = `${webBase}/login?from=desktop&type=signIn&nonce=${nonce}`;

    // Open external URL (the mock server will redirect back to the deep link).
    const deepLink = `agentstudio://auth/callback?token=${loginToken}&nonce=${nonce}`;
    await page.evaluate((url) => {
      void window.__apis?.system?.openExternal?.(url);
    }, callback);

    // Simulate the main process receiving the deep link.
    await simulateDeepLink(app, deepLink);

    // Expect navigation to the main workspace.
    await expect(page).toHaveURL(/.*\/app/);
    await expect(page.locator("[aria-label='Sidebar']")).toBeVisible({ timeout: 15_000 });
  });
});
