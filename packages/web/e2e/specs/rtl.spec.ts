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

  // N21: the run-graph canvas lays a row out start-to-end, so an Arabic run
  // must read right-to-left. The panel already mirrored with logical CSS; this
  // pins the *order*, which no CSS property can express, by comparing which node
  // card sits in which column after Organize.
  test.describe("canvas run graph direction (N21)", () => {
    async function openCanvas(page: Page, locale: "en" | "ar") {
      await mockAuth(page);
      await page.goto("/app");
      await setThemeAndLocale(page, "light", locale);
      const surface = page.getByTestId("canvas-surface");
      await expect(surface).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("canvas-node").first()).toBeVisible();
      return surface;
    }

    /** The left edge of each node card, keyed by its node id. */
    async function columns(page: Page): Promise<Map<string, number>> {
      const cards = page.getByTestId("canvas-node");
      const count = await cards.count();
      const map = new Map<string, number>();
      for (let i = 0; i < count; i += 1) {
        const card = cards.nth(i);
        const box = await card.boundingBox();
        map.set((await card.getAttribute("data-node-id")) ?? `node-${i}`, box?.x ?? -1);
      }
      return map;
    }

    test("an Arabic run graph mirrors the row from the right after Organize", async ({ page }) => {
      await openCanvas(page, "ar");
      await page.getByRole("button", { name: /تنظيم|Organize/ }).click();
      const rtl = await columns(page);

      // Re-run the same graph in English: identical nodes, mirrored columns.
      await openCanvas(page, "en");
      await page.getByRole("button", { name: /تنظيم|Organize/ }).click();
      const ltr = await columns(page);

      const rtlIds = [...rtl.keys()].sort();
      expect(rtlIds).toEqual([...ltr.keys()].sort());
      // The first sibling of the layer takes the last sibling's column, i.e. the
      // row is mirrored rather than merely re-flowed.
      const first = rtlIds[1];
      const last = rtlIds[rtlIds.length - 1];
      expect(rtl.get(first)).toBeCloseTo(ltr.get(last)!, -1);
      expect(rtl.get(last)).toBeCloseTo(ltr.get(first)!, -1);
      // A single-node layer is not mirrored: the root keeps its own column.
      expect(rtl.get(rtlIds[0])).toBeCloseTo(ltr.get(ltr.keys().next().value!)!, -1);
    });

    test("the canvas surface itself stays ltr while the chrome follows the locale", async ({ page }) => {
      await openCanvas(page, "ar");
      // Graph space is ltr by definition; only the chrome around it mirrors.
      await expect(page.getByTestId("canvas-surface")).toHaveAttribute("dir", "ltr");
      await expect(page.getByTestId("canvas-panel")).toBeVisible();
    });
  });
});
