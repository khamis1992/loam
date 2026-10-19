import { test, expect, setThemeAndLocale } from "../harness/fixtures.js";

test.describe("RTL / Arabic §12.3", () => {
  test("switching to Arabic sets dir=rtl and mirrors the sidebar", async ({ page }) => {
    await page.goto("app://agent/app");
    await setThemeAndLocale(page, "light", "ar");

    const html = await page.locator("html").evaluate((el) => ({ lang: el.lang, dir: el.dir }));
    expect(html.dir).toBe("rtl");
    expect(html.lang).toBe("ar");

    // Sidebar should be visually on the right (logical start in RTL).
    const nav = page.locator("nav");
    const box = await nav.boundingBox();
    expect(box).not.toBeNull();
    const width = await page.evaluate(() => window.innerWidth);
    expect(box!.x + box!.width).toBeGreaterThan(width - 10);
  });

  test("English layout uses dir=ltr", async ({ page }) => {
    await page.goto("app://agent/app");
    await setThemeAndLocale(page, "light", "en");
    const dir = await page.locator("html").getAttribute("dir");
    expect(dir).toBe("ltr");
  });
});
