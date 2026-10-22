import { test, expect } from "@playwright/test";

test.describe("login flow §9.1", () => {
  test("sign in via deep link lands on /app", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      let storedToken: string | null = null;
      w.__apis = {
        auth: {
          getToken: () => storedToken,
          setToken: (tok: string) => {
            storedToken = tok;
          },
          removeToken: () => {
            storedToken = null;
          },
          notifyLoginSuccess: () => {
            if ((w as unknown as { __onLoginSuccess?: () => void }).__onLoginSuccess) {
              (w as unknown as { __onLoginSuccess: () => void }).__onLoginSuccess();
            }
          },
        },
        system: {
          openExternal: () => undefined,
        },
      };
      w.__events = {
        auth: {
          onLoginSuccess: (cb: () => void) => {
            (w as unknown as { __onLoginSuccess?: () => void }).__onLoginSuccess = cb;
            return () => {};
          },
          onLoginError: () => () => {},
        },
      };
      w.desktopLocalStorage = {
        getItem: (key: string) => (key === "session_token" ? storedToken : null),
        setItem: (_key: string, val: string) => {
          storedToken = val;
        },
        removeItem: () => {
          storedToken = null;
        },
      };
    });

    await page.route("**/user.v1.UserService/UserInfo", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ firstname: "E2E", lastname: "User", displayname: "E2E User", email: "e2e@example.com" }),
      }),
    );

    await page.goto("/login");
    await expect(page.getByRole("heading", { name: /Sign in/ })).toBeVisible({ timeout: 10_000 });

    const signInButton = page.getByRole("button", { name: "Sign in" });
    await expect(signInButton).toBeEnabled();
    await signInButton.click();

    // Simulate receiving the deep link callback in the desktop process
    await page.evaluate(() => {
      const w = window as unknown as {
        __apis?: { auth?: { setToken?: (t: string) => void; notifyLoginSuccess?: () => void } };
      };
      w.__apis?.auth?.setToken?.("lt-test-123");
      w.__apis?.auth?.notifyLoginSuccess?.();
    });

    // Expect navigation to the main workspace.
    await expect(page).toHaveURL(/.*\/app/);
    await expect(page.locator("nav")).toBeVisible({ timeout: 15_000 });
  });
});
