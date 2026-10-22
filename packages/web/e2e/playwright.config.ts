import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const platform = os.platform();
const appDistPath =
  process.env.E2E_APP_PATH ??
  (platform === "win32"
    ? path.resolve(__dirname, "../../desktop/dist/win-unpacked/AgentStudio.exe")
    : platform === "darwin"
      ? path.resolve(__dirname, "../../desktop/dist/mac-arm64/Agent Studio.app/Contents/MacOS/Agent Studio")
      : path.resolve(__dirname, "../../desktop/dist/linux-unpacked/agent-studio"));

const fallbackMain = path.resolve(__dirname, "../../../electron/main.cjs");

export default defineConfig({
  testDir: "./specs",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "../../web/e2e/report" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    appDistPath,
    appFallbackMain: fallbackMain,
  },
  projects: [
    {
      name: "electron",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
  // §12.3 visual checklist outputs
  outputDir: path.resolve(__dirname, "results"),
});
