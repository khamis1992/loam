import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { ROOT } from "../config.js";
import { PreviewService } from "../preview/serve.js";
import { browserTools, closeBrowser } from "../tools/browser.js";

/** Offline verification: browser session recording (video + action trace JSON). */
async function main(): Promise<void> {
  const dir = path.join(ROOT, "workspace", "_tracetest");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html><html><body style="font-family:sans-serif">
      <h1>Trace test</h1>
      <input id="q" placeholder="City" />
      <button id="go" onclick="document.getElementById('out').textContent='OK:'+document.getElementById('q').value">Go</button>
      <div id="out">-</div>
    </body></html>`,
    "utf8",
  );

  const preview = new PreviewService();
  const inst = await preview.start(dir, 4502);

  const cfg = {
    workspace: ROOT,
    policy: { networkEnabled: true, allowOutsideWorkspaceRead: false, denyCommandPatterns: [], allowCommandPatterns: [], maxCommandSeconds: 60 },
    browser: { channel: "msedge", headless: true, viewport: { width: 1280, height: 800 } },
    computerUse: { enabled: false, screenshotDir: ROOT },
  } as never;
  const ctx = { cfg, workspace: ROOT, emit: () => {} } as never;
  const tool = (name: string) => {
    const t = browserTools.find((x) => x.name === name);
    if (!t) throw new Error(`missing tool ${name}`);
    return t;
  };
  const run = async (name: string, args: Record<string, unknown>) => tool(name).run(args, ctx);

  const results: Record<string, unknown> = {};
  try {
    results.trace_start = (await run("browser_trace_start", { name: "check-trace" })).ok;

    const open = await run("browser_open", { url: inst.url });
    const pageId = /pageId=(\S+)/.exec(open.content)?.[1] ?? "";
    results.page = pageId;

    const table = await run("browser_table", { pageId });
    const snapshotId = Number(/snapshotId=(\d+)/.exec(table.content)?.[1] ?? 0);
    const idx = (text: string, needle: string): number => {
      const m = new RegExp(`\\[(\\d+)\\][^\\n]*${needle}`, "i").exec(text);
      return m ? Number(m[1]) : 0;
    };
    const inputIdx = idx(table.content, "City");
    const goIdx = idx(table.content, "Go");
    results.indexes = { inputIdx, goIdx, snapshotId };

    await run("browser_act", { pageId, op: "TYPE_TEXT", index: inputIdx, text: "زيوريخ", snapshotId });
    const table2 = await run("browser_table", { pageId });
    const snap2 = Number(/snapshotId=(\d+)/.exec(table2.content)?.[1] ?? 0);
    const goIdx2 = idx(table2.content, "Go");
    const click = await run("browser_act", { pageId, op: "CLICK", index: goIdx2, snapshotId: snap2 });
    results.click_ok = click.ok;

    const state = (await run("browser_trace_status", {})).content;
    results.state_has_actions = /"op": "CLICK"/.test(state) || /"op":"CLICK"/.test(state);

    const stop = await run("browser_trace_stop", {});
    results.stop_ok = stop.ok;
    const videoPath = /video: ([^\n]+)/.exec(stop.content)?.[1]?.split(",")[0]?.trim() ?? "";
    const tracePath = /trace: ([^\n(]+)/.exec(stop.content)?.[1]?.trim() ?? "";
    results.video = videoPath;
    results.trace = tracePath;
    const videoBytes = videoPath && fs.existsSync(videoPath) ? fs.statSync(videoPath).size : 0;
    results.video_bytes = videoBytes;

    let actions = 0;
    if (tracePath && fs.existsSync(tracePath)) {
      const parsed = JSON.parse(fs.readFileSync(tracePath, "utf8")) as { actions?: unknown[] };
      actions = parsed.actions?.length ?? 0;
    }
    results.trace_actions = actions;

    const pass = results.trace_start === true && results.click_ok === true && videoBytes > 0 && actions >= 1;
    results.PASS = pass;
    console.log(JSON.stringify(results, null, 1));
    if (!pass) process.exitCode = 1;
  } finally {
    await closeBrowser();
    preview.stop();
  }
}

void main().catch((err) => {
  console.error(`trace check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
