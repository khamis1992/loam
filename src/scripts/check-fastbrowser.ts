import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { ROOT } from "../config.js";
import { PreviewService } from "../preview/serve.js";
import { buildTable, performAct, closeBrowser } from "../tools/browser.js";

/** Offline verification of the fast indexed action space (no LLM involved). */
async function main(): Promise<void> {
  const dir = path.join(ROOT, "workspace", "_fasttest");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html><html><body style="font-family:sans-serif">
      <h1>Fast browser test</h1>
      <input id="q" placeholder="City" />
      <select id="cls"><option>Economy</option><option>Business</option></select>
      <button id="go" onclick="document.getElementById('out').textContent='HELLO:'+document.getElementById('q').value+':'+document.getElementById('cls').value">Go</button>
      <div id="out">-</div>
    </body></html>`,
    "utf8",
  );

  const preview = new PreviewService();
  const inst = await preview.start(dir, 4501);
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();

  const results: Record<string, unknown> = {};
  try {
    await page.goto(inst.url, { waitUntil: "domcontentloaded" });
    const t1 = await buildTable(page);
    results.table1_items = t1.result.items.map((i) => `${i.i}:${i.role}:${i.name}`);

    const inputIdx = t1.result.items.find((i) => i.name === "City")?.i ?? 0;
    const selectIdx = t1.result.items.find((i) => i.tag === "select")?.i ?? 0;
    const goIdx = t1.result.items.find((i) => i.name === "Go")?.i ?? 0;
    results.indexes = { inputIdx, selectIdx, goIdx };

    const type = await performAct(page, { op: "TYPE_TEXT", index: inputIdx, text: "زيوريخ", snapshotId: t1.snapshotId });
    results.type = type;

    const t2 = await buildTable(page);
    results.input_value_after_type = t2.result.items.find((i) => i.name === "City")?.value;

    const sel = await performAct(page, { op: "SELECT", index: selectIdx, text: "Business", snapshotId: t2.snapshotId });
    results.select = sel;

    const t3 = await buildTable(page);
    results.select_value_after_select = t3.result.items.find((i) => i.tag === "select")?.value;
    const goIdx2 = t3.result.items.find((i) => i.name === "Go")?.i ?? goIdx;

    const click = await performAct(page, { op: "CLICK", index: goIdx2, snapshotId: t3.snapshotId });
    results.click = click;

    const outText = await page.locator("#out").textContent();
    results.out = outText;

    const stale = await performAct(page, { op: "CLICK", index: goIdx2, snapshotId: t3.snapshotId - 1 });
    results.stale_rejected = stale.ok === false && /stale/i.test(stale.message);

    const passed =
      results.input_value_after_type === "زيوريخ" &&
      results.select_value_after_select === "Business" &&
      outText === "HELLO:زيوريخ:Business" &&
      results.stale_rejected === true;
    results.PASS = passed;
    console.log(JSON.stringify(results, null, 1));
    if (!passed) process.exitCode = 1;
  } finally {
    await browser.close();
    await closeBrowser();
    preview.stop();
  }
}

void main().catch((err) => {
  console.error(`fast-browser check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
