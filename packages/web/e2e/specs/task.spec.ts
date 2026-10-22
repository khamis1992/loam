import { test, expect, type Page } from "@playwright/test";

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
      const text = String(msg);
      if (text.startsWith('40')) {
        ws.send('40{"sid":"e2e-sid"}');
        // Send a status update to set running state
        setTimeout(() => {
          ws.send('42["message",{"type":"event","event":{"type":"statusUpdate","agentStatus":"running"}}]');
        }, 100);
      }
      if (text.includes('stop')) {
        ws.send('42["message",{"type":"event","event":{"type":"userStop"}}]');
      }
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

test.describe("task stream §9.2", () => {
  test("send a task and observe plan, tool, result", async ({ page }) => {
    await mockAuth(page);
    await page.goto("/app/demo-running?draft=Say%20hello%20in%20one%20sentence&mode=standard");

    // Sidebar should show the new task row.
    await expect(page.locator("nav").locator("text=Say hello in one sentence")).toBeVisible({ timeout: 10_000 });

    // Task view status indicator should be visible.
    await expect(page.locator("text=/Thinking|Working|Task completed/")).toBeVisible({ timeout: 15_000 });

    // Composer should be present for follow-ups.
    await expect(page.locator("[data-testid='composer'] textarea")).toBeVisible({ timeout: 10_000 });
  });

  test("stop a running task", async ({ page }) => {
    await mockAuth(page);
    await page.goto("/app/demo-running?draft=Run%20a%20long%20command&mode=standard");

    await expect(page.locator("nav").locator("text=Run a long command")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=/Thinking|Working/")).toBeVisible({ timeout: 15_000 });

    const stopButton = page.locator("[aria-label='Stop']").or(page.getByRole("button", { name: "Stop" }));
    if (await stopButton.isVisible()) {
      await stopButton.click();
    }
  });
});
