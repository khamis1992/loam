#!/usr/bin/env node
/**
 * §12.3 visual checklist runner.
 *
 * Usage (after packaging the app and starting the mock server):
 *   npx tsx packages/web/e2e/harness/visualCheck.ts
 *
 * It captures every rebuilt screen in light/dark × en/ar and compares against
 * the textual descriptions in BUILD_SPEC.md §5.9. This is a human-driven
 * checklist: the runner produces screenshots; a reviewer ticks the checklist.
 */

import { _electron } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { launchApp } from "./electronApp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const THEMES: Array<"light" | "dark"> = ["light", "dark"];
const LOCALES: Array<"en" | "ar"> = ["en", "ar"];
const CHECKPOINTS = [
  { name: "S1-chrome", route: "/app", selector: "header" },
  { name: "S2-sidebar", route: "/app", selector: "nav" },
  { name: "S3-home", route: "/app", selector: "[data-testid='home-screen']" },
  { name: "S7-composer", route: "/app", selector: "[data-testid='composer']" },
  { name: "S4-task-running", route: "/app", selector: "[data-testid='task-screen']" },
  { name: "S8-settings", route: "/app", selector: "[role='dialog']" },
  { name: "S9-search", route: "/app", selector: "[role='dialog']" },
  { name: "S14-rtl", route: "/app", selector: "html" },
];

async function main() {
  const app = await launchApp({
    appDistPath: process.env.E2E_APP_PATH ?? "",
    appFallbackMain: path.resolve(__dirname, "../../../../electron/main.cjs"),
  });
  const page = await app.firstWindow();
  const outRoot = path.resolve(__dirname, "../visual");
  fs.mkdirSync(outRoot, { recursive: true });

  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      const dir = path.join(outRoot, `${theme}-${locale}`);
      fs.mkdirSync(dir, { recursive: true });
      await page.evaluate(
        ({ t, l }) => {
          document.documentElement.classList.remove("light", "dark");
          document.documentElement.classList.add(t);
          document.documentElement.lang = l;
          document.documentElement.dir = l === "ar" ? "rtl" : "ltr";
        },
        { t: theme, l: locale },
      );
      for (const cp of CHECKPOINTS) {
        await page.goto(`app://agent${cp.route}`);
        await page.waitForTimeout(500);
        try {
          await page.waitForSelector(cp.selector, { timeout: 5000 });
        } catch {
          /* checkpoint may not exist yet; still capture */
        }
        const file = path.join(dir, `${cp.name}.png`);
        await page.screenshot({ path: file, fullPage: false });
        console.log(`[visual] ${theme}/${locale}: ${file}`);
      }
    }
  }

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
