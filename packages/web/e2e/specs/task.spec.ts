import { test, expect, setThemeAndLocale } from "../harness/fixtures.js";

test.describe("task stream §9.2", () => {
  test("send a task and observe plan, tool, result", async ({ page }) => {
    await page.goto("app://agent/app");
    await page.waitForSelector("[data-testid='composer']", { timeout: 15_000 });

    const composer = page.locator("[data-testid='composer'] textarea");
    await composer.fill("Say hello in one sentence");
    await composer.press("Enter");

    // Sidebar should show the new task row.
    await expect(page.locator("nav").locator("text=Say hello in one sentence")).toBeVisible({ timeout: 10_000 });

    // Running state.
    await expect(page.locator("text=Working")).toBeVisible({ timeout: 15_000 });

    // Completed state.
    await expect(page.locator("text=Task completed")).toBeVisible({ timeout: 60_000 });

    // Follow-up suggestions.
    await expect(page.locator("[data-testid='suggestion-row']").first()).toBeVisible({ timeout: 10_000 });
  });

  test("stop a running task", async ({ page }) => {
    await page.goto("app://agent/app");
    await page.waitForSelector("[data-testid='composer']", { timeout: 15_000 });

    const composer = page.locator("[data-testid='composer'] textarea");
    await composer.fill("Run a long command");
    await composer.press("Enter");

    await page.waitForSelector("[aria-label='Stop']", { timeout: 10_000 });
    await page.click("[aria-label='Stop']");

    await expect(page.locator("text=stopped")).toBeVisible({ timeout: 15_000 });
  });
});
