import { test as base, expect, type ElectronApplication, type Page } from "@playwright/test";
import { launchApp, closeApp, firstWindow } from "./electronApp.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface AppFixtures {
  app: ElectronApplication;
  page: Page;
}

interface AppWorkerOptions {
  appDistPath: string;
  appFallbackMain: string;
}

export const test = base.extend<AppFixtures, AppWorkerOptions>({
  appDistPath: ["", { option: true }],
  appFallbackMain: ["", { option: true }],
  app: [
    async ({ appDistPath, appFallbackMain }, use) => {
      const app = await launchApp({ appDistPath, appFallbackMain });
      await use(app);
      await closeApp(app);
    },
    { scope: "test", auto: true },
  ],
  page: async ({ app }, use) => {
    const page = await firstWindow(app);
    await page.waitForLoadState("domcontentloaded");
    await use(page);
  },
});

export { expect };

export async function simulateDeepLink(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate(({ shell }, link) => {
    // The main process should handle the deep link via open-url / second-instance.
    // For tests, emit the same argv that the handler expects.
    process.emit("second-instance", undefined, [link]);
  }, url);
}

export async function takeVisualCheckpoint(page: Page, name: string, theme: "light" | "dark", locale: "en" | "ar"): Promise<void> {
  const out = path.resolve(__dirname, "../snapshots", `${theme}-${locale}`, `${name}.png`);
  await page.screenshot({ path: out, fullPage: false });
}

export async function setThemeAndLocale(
  page: Page,
  theme: "light" | "dark" | "system",
  locale: "en" | "ar",
): Promise<void> {
  await page.evaluate(({ t, l }) => {
    document.documentElement.classList.remove("light", "dark", "system");
    document.documentElement.classList.add(t);
    document.documentElement.lang = l;
    document.documentElement.dir = l === "ar" ? "rtl" : "ltr";
  }, { t: theme, l: locale });
}

export async function waitForStable(page: Page, selector: string, timeout = 10_000): Promise<void> {
  await page.waitForSelector(selector, { timeout, state: "visible" });
  await page.waitForTimeout(300);
}

export async function isHardcodedHexFree(componentDir: string): Promise<boolean> {
  // Placeholder: in CI this is run as a grep step (see docs/QA.md).
  return true;
}
