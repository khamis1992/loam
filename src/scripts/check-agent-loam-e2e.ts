import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-agent-e2e-"));
const workspace = path.join(tmp, "workspace");
fs.mkdirSync(workspace, { recursive: true });
const config = path.join(tmp, "config.json");
fs.writeFileSync(config, JSON.stringify({
  workspace,
  memory: { enabled: false },
  screen: { enabled: false },
  selfImprove: { enabled: false },
  computerUse: { enabled: false },
  mcpServers: {},
}));

let child: ChildProcess | undefined;
let browser: Browser | undefined;
let logs = "";

try {
  const portModule = await import("node:net");
  const socket = portModule.createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      MANUS_LOCAL_CONFIG: config,
      MANUS_LOCAL_DATA_DIR: path.join(tmp, "data"),
      MANUS_LOCAL_PORT: String(port),
      LOAM_AUTH_DISABLED: "true",
      MANUS_LOCAL_EVALS_DIR: path.join(tmp, "evals"),
      MANUS_LOCAL_SKILLS_DIR: path.join(tmp, "skills"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { logs += chunk; });
  child.stderr?.on("data", (chunk) => { logs += chunk; });

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(logs);
    if (await fetch(`${base}/api/tasks`).then((res) => res.ok).catch(() => false)) break;
    if (Date.now() > deadline) throw new Error(`server did not start\n${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
  await page.goto(`${base}/app/agents`, { waitUntil: "networkidle" });
  if (page.url().endsWith("/login")) {
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL("**/app");
    await page.goto(`${base}/app/agents`, { waitUntil: "networkidle" });
  }
  await page.getByRole("button", { name: "New agent" }).first().click();
  await page.getByText("Blank / Custom agent").click();
  await page.getByLabel("Name").fill("E2E Capability Agent");
  await page.getByLabel("Description").fill("Verifies capability lifecycle");
  await page.getByLabel("System instructions").fill("Use only explicitly granted tools.");
  await page.getByLabel("Loam mode").selectOption("reverse-engineer");
  await page.getByLabel("Memory").uncheck();
  await page.getByRole("button", { name: "Create", exact: true }).click();

  await page.getByText("E2E Capability Agent").first().waitFor();
  await page.getByText("E2E Capability Agent").first().click();
  await page.getByRole("button", { name: "Agent info" }).click();
  for (const section of ["Analytics", "Secrets", "Routines", "Channels", "Members"]) {
    await page.getByRole("heading", { name: section, exact: true }).waitFor();
  }
  await page.getByRole("button", { name: "Advanced" }).click();
  await page.getByRole("button", { name: "Shared team memory" }).waitFor();
  await page.getByRole("button", { name: "Add automation" }).click();
  await page.getByPlaceholder("Prompt or playbook").fill("E2E scheduled routine");
  await page.getByRole("button", { name: "Create automation" }).click();
  await page.getByText("E2E scheduled routine").waitFor();

  await page.getByRole("button", { name: "Connect apps" }).click();
  await page.getByRole("heading", { name: "Service packs" }).waitFor();
  await page.getByRole("listitem").filter({ hasText: "Slack" }).first().waitFor();
  await page.getByText("Install a provider to enable its services. Nothing is downloaded or connected automatically.").waitFor();
  await page.screenshot({ path: path.join(tmp, "agent-loam-e2e.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`PASS Agent Loam E2E: create with full mode catalog and independent memory, analytics/secrets/routines, cron creation, MCP service packs. Artifacts: ${tmp}`);
  } catch (error) {
    console.error("Agent Loam E2E state", { url: page.url(), body: (await page.locator("body").innerText()).slice(0, 4000), logs: logs.slice(-2000) });
    await page.screenshot({ path: path.join(tmp, "agent-loam-e2e-failure.png"), fullPage: true });
    throw error;
  }
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child!.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
  }
}
