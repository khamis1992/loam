/**
 * J7 e2e acceptance: idle session hibernation in the real app shell.
 *
 * The renderer-side release is driven through the view's own test hook
 * (`window.__loamHibernation`), so the spec exercises the same code path a real
 * 30-minute idle would, without waiting for the clock. What it asserts is the
 * user-visible contract from `.jtask.md`:
 *
 *  1. an open chat view renders its transcript,
 *  2. hibernation unmounts the rendered message DOM (the derived render caches),
 *  3. the canonical session state is still there while hibernated (the count is
 *     reported), so nothing authoritative was thrown away,
 *  4. waking restores the transcript, and
 *  5. a draft typed before hibernation is exactly what is in the composer after
 *     waking: the first keystroke never loses the typed input.
 *
 * Fully offline: the API and the socket are mocked, no model is called.
 */
import { test, expect, type Page } from "@playwright/test";

/** The same auth/API mocking the other app specs use. */
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
    w.__AGENT_STUDIO_ENV__ = { apiBase: 'http://localhost:8787', socketBase: 'http://localhost:8787' };
  });

  await page.routeWebSocket(/.*\/socket\.io\/.*/, (ws) => {
    ws.send('0{"sid":"e2e-sid","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
    ws.onMessage((msg) => {
      if (String(msg).startsWith('40')) ws.send('40{"sid":"e2e-sid"}');
    });
  });

  await page.route("**/user.v1.UserService/UserInfo", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ firstname: "E2E", lastname: "User", displayname: "E2E User", email: "e2e@example.com" }),
    }),
  );

  await page.route("**/session.v1.SessionService/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [] }),
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

/** Build the same canonical fixture the RSS bench renders. */
function fixtureEvents(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `e2e-fixture-${i}`,
    type: "chat",
    timestamp: 1_700_000_000_000 + i,
    sender: i % 3 === 0 ? "user" : "assistant",
    messageType: "text",
    content: `E2E fixture message ${i}. ` + "lorem ipsum dolor sit amet ".repeat(4),
    attachments: [],
    deliveryKind: "result",
  }));
}

const SESSION_UID = "demo-running";

/** Wait until the mounted chat view has attached the hibernation hook. */
async function waitForHook(page: Page) {
  await page.waitForFunction(
    () => Boolean((window as unknown as { __loamHibernation?: { __attached?: boolean } }).__loamHibernation?.__attached),
    undefined,
    { timeout: 30_000 },
  );
}

test.describe("J7 session hibernation", () => {
  test("drops the rendered message DOM while preserving canonical state and the draft", async ({ page }) => {
    await mockAuth(page);
    await page.goto(`/app/${SESSION_UID}`);
    await waitForHook(page);

    // Render a real transcript through the view's own injection path.
    await page.evaluate((events) => {
      (window as unknown as {
        __loamHibernation: { injectEvents: (id: string, events: unknown[]) => void };
      }).__loamHibernation.injectEvents("demo-running", events);
    }, fixtureEvents(60));

    const list = page.locator("[data-testid='event-list']");
    await expect(list).toHaveAttribute("data-hibernated", "false", { timeout: 15_000 });
    // The rendered rows are the derived DOM hibernation must release.
    expect(await list.locator("li").count()).toBeGreaterThan(1);

    // Type a draft, then hibernate: this is the "idle" the feature exists for.
    const composer = page.locator("[data-testid='composer'] textarea");
    await composer.fill("draft survives hibernation");

    const released = await page.evaluate(async () => {
      return (window as unknown as {
        __loamHibernation: { hibernate: (id: string) => Promise<{ released: boolean; entries: number }> };
      }).__loamHibernation.hibernate("demo-running");
    });
    expect(released.released).toBe(true);

    // The rendered DOM is gone: at most the single status row remains.
    await expect(list).toHaveAttribute("data-hibernated", "true", { timeout: 10_000 });
    expect(await list.locator("li").count()).toBeLessThanOrEqual(1);
    // The canonical count is still reported, so nothing authoritative was lost.
    const reported = Number(await list.getAttribute("data-event-count"));
    expect(reported).toBeGreaterThan(1);

    // Wake restores the transcript and keeps the typed draft exactly.
    await page.evaluate(async () => {
      await (window as unknown as {
        __loamHibernation: { wake: (id: string) => Promise<void> };
      }).__loamHibernation.wake("demo-running");
    });
    await expect(list).toHaveAttribute("data-hibernated", "false", { timeout: 10_000 });
    expect(await list.locator("li").count()).toBeGreaterThan(1);
    await expect(composer).toHaveValue("draft survives hibernation");
  });

  test("does not hibernate while the view has no mounted hook to hibernate", async ({ page }) => {
    await mockAuth(page);
    await page.goto(`/app/${SESSION_UID}`);
    await waitForHook(page);

    // Before any transcript exists there is no derived state to release, so a
    // hibernate request is a no-op rather than an error.
    const released = await page.evaluate(async () => {
      return (window as unknown as {
        __loamHibernation: { hibernate: (id: string) => Promise<{ released: boolean }> };
      }).__loamHibernation.hibernate("demo-running");
    });
    expect(released.released).toBe(false);

    // The view stays live: the composer is still usable.
    await expect(page.locator("[data-testid='composer'] textarea")).toBeVisible();
  });
});
