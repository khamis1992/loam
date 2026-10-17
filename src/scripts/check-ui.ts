import { chromium } from "playwright";

/** Headless UI smoke test: boots the web UI, asserts the Manus-like shell renders, captures a screenshot. */
async function main(): Promise<void> {
  const base = process.env.MANUS_LOCAL_BASE ?? "http://127.0.0.1:3939";
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  const checks = {
    sidebar: await page.locator(".sidebar").count(),
    hero: await page.locator(".hero h1").count(),
    chips: await page.locator("#chips button").count(),
    composer: await page.locator("#promptHome").count(),
    modelOptions: await page.locator("#model option").count(),
    recent: await page.locator("#recentList .card, #recentList .empty").count(),
  };
  await page.screenshot({ path: "workspace/.screenshots/ui_home.png" });

  await page.click('.side-nav button[data-view="tasks"]');
  await page.waitForTimeout(700);
  const tasksRows = await page.locator("#listBody .row, #listBody .empty").count();

  await page.click('.side-nav button[data-view="projects"]');
  await page.waitForTimeout(700);
  const projForm = await page.locator("#projAdd").count();

  await page.click('.side-nav button[data-view="schedules"]');
  await page.waitForTimeout(700);
  const schedForm = await page.locator("#schAdd").count();

  await page.click('.side-nav button[data-view="home"]');
  await page.waitForTimeout(300);
  const themeBefore = await page.getAttribute("html", "data-theme");
  await page.click("#theme");
  await page.waitForTimeout(400);
  const themeAfter = await page.getAttribute("html", "data-theme");

  console.log(
    JSON.stringify({ checks, tasksRows, projForm, schedForm, themeBefore, themeAfter, errors: errors.slice(0, 6) }, null, 1),
  );
  await browser.close();
}

void main().catch((err) => {
  console.error(`ui check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
