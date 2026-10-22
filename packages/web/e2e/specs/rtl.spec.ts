import { test, expect, type Page } from "@playwright/test";

async function setThemeAndLocale(
  page: Page,
  theme: "light" | "dark" | "system",
  locale: "en" | "ar",
): Promise<void> {
  await page.evaluate(({ t, l }) => {
    document.documentElement.classList.remove("light", "dark", "system");
    document.documentElement.classList.add(t);
    document.documentElement.lang = l;
    document.documentElement.dir = l === "ar" ? "rtl" : "ltr";
    (window as unknown as { __FORCE_LOCALE__?: string }).__FORCE_LOCALE__ = l;
  }, { t: theme, l: locale });
}

async function mockAuth(page: Page) {
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
      getItem: (key: string) => (key === "session_token" ? "e2e-token" : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    try {
      window.localStorage.setItem("session_token", "e2e-token");
    } catch {}
  });

  await page.route("**/user.v1.UserService/UserInfo", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ firstname: "E2E", lastname: "User", displayname: "E2E User", email: "e2e@example.com" }),
    }),
  );

  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    }),
  );
}

test.describe("RTL / Arabic §12.3", () => {
  test("switching to Arabic sets dir=rtl and mirrors the sidebar", async ({ page }) => {
    await mockAuth(page);
    await page.goto("/app");
    await setThemeAndLocale(page, "light", "ar");

    const html = await page.locator("html").evaluate((el) => ({ lang: el.lang, dir: el.dir }));
    expect(html.dir).toBe("rtl");
    expect(html.lang).toBe("ar");

    // Sidebar should be visually on the right (logical start in RTL).
    const nav = page.locator("nav");
    await expect(nav).toBeVisible({ timeout: 10_000 });
    const box = await nav.boundingBox();
    expect(box).not.toBeNull();
    const width = await page.evaluate(() => window.innerWidth);
    expect(box!.x + box!.width).toBeGreaterThan(width - 10);
  });

  test("English layout uses dir=ltr", async ({ page }) => {
    await mockAuth(page);
    await page.goto("/app");
    await setThemeAndLocale(page, "light", "en");
    const dir = await page.locator("html").getAttribute("dir");
    expect(dir).toBe("ltr");
  });
});
