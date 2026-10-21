/**
 * MF7 unit tests: url-watch trigger. A fake injected fetcher drives the poll
 * loop; a page whose text is unchanged creates no task, a page whose text
 * changed creates exactly one run whose prompt carries the unified diff of the
 * old vs. new text. Plus: selector/regex extraction, interval clamping, the
 * connector registry hook (watchConnector with a mock) and the always-on
 * effective-run-tool exposure of watch_url.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

type Db = typeof import("../db.js");
type UrlWatch = typeof import("../urlWatch.js");
type RunTools = typeof import("../runTools.js");

let tmpDir = "";
let closeDb: () => void;
let db: Db;
let urlWatch: UrlWatch;

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

const PAGE = "<html><head><script>var noise=1</script></head><body><h1>أخبار اليوم</h1><div id=\"feed\"><p>السطر الأول</p></div></body></html>";

describe("url-watch trigger (MF7)", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-urlwatch-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    db = await import("../db.js");
    urlWatch = await import("../urlWatch.js");
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("unchanged page → no run; changed page → exactly one run with a diff", async () => {
    // Two schedules share the same fake page so each gets its own baseline.
    let page = PAGE;
    const runs: Array<{ prompt: string; scheduleId: string }> = [];
    const url = "http://fake.local/feed";
    const a = urlWatch.createUrlWatch({ url, intervalSeconds: 300, prompt: "راقب الأخبار", selector: "#feed" });
    assert.ok(!("error" in a), "creation must succeed");
    const stop = urlWatch.startUrlWatchers({
      run: async (o) => { runs.push({ prompt: o.prompt, scheduleId: o.scheduleId }); return "task_urlwatch_1"; },
      fetcher: async () => page,
      intervalMs: 20,
      dueEverySeconds: 0,
    });
    try {
      // 1) baseline: no run, hash recorded
      await waitFor(() => db.getSchedule(a.scheduleId)?.lastWatchHash !== undefined);
      const baseline = db.getSchedule(a.scheduleId)!;
      assert.ok(baseline.lastWatchHash, "baseline hash must exist");
      assert.equal(runs.length, 0, "baseline read must not create a task");
      // 2) unchanged: another due cycle must create no task
      await waitFor(() => (db.getSchedule(a.scheduleId)!.lastWatchCheckedAt ?? "") > baseline.lastWatchCheckedAt!);
      assert.equal(runs.length, 0, "unchanged page must not create a task (no model call)");
      // 3) change: the page text changed → exactly one task with a diff
      page = PAGE.replace("السطر الأول", "السطر الأول والثاني");
      await waitFor(() => runs.length === 1, 8000);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(runs.length, 1, "changed page must create exactly one task");
      assert.equal(runs[0]!.scheduleId, a.scheduleId);
      assert.match(runs[0]!.prompt, /راقب الأخبار/);
      assert.match(runs[0]!.prompt, /```diff/);
      assert.match(runs[0]!.prompt, /\+السطر الأول والثاني/, "diff must carry the added line");
      assert.match(runs[0]!.prompt, /-السطر الأول/, "diff must carry the removed line");
    } finally {
      stop();
      urlWatch.deleteUrlWatch(a.scheduleId);
    }
  });

  it("selector and regex extraction work on the fake page", () => {
    assert.ok(urlWatch.extractWatchText(PAGE, "#feed").includes("السطر الأول"));
    assert.ok(!urlWatch.extractWatchText(PAGE, "#feed").includes("noise"), "script noise must not leak into a selector read");
    assert.equal(urlWatch.extractWatchText(PAGE, ".missing"), "", "absent element extracts empty text, not the page");
    assert.equal(
      urlWatch.extractWatchText("أ ع: 1 ن ب: 2", "/[أب]\\s[عن]/g"),
      "أ ع",
      "regex extractor returns its matches",
    );
    assert.ok(urlWatch.extractWatchText(PAGE).includes("أخبار اليوم"), "selector-less read yields page text");
    assert.ok(!urlWatch.extractWatchText(PAGE).includes("var noise"), "script body must be dropped");
    assert.equal(
      urlWatch.extractWatchText("cat:1 dog:2", "re:\\w+:\\d"),
      "cat:1\ndog:2",
      "regex extractor joins every match",
    );
  });

  it("interval clamps to the 5-minute floor and diffs are bounded uniffs", () => {
    assert.equal(urlWatch.clampWatchIntervalSeconds(60), 300);
    assert.equal(urlWatch.clampWatchIntervalSeconds(900), 900);
    const diff = urlWatch.unifiedDiff("a\nb\nc", "a\nb\nC");
    assert.match(diff, /^@@ /);
    assert.match(diff, /[-]a/);
    assert.match(diff, /\+C/);
  });

  it("connector registry hook: a registered mock connector drives the content", async () => {
    const url = "http://fake.local/issues";
    let connectorCalls = 0;
    const reactions: string[] = [];
    const stopConnector = urlWatch.watchConnector("github-issues", async () => {
      connectorCalls++;
      return "issues text v1";
    });
    assert.ok(urlWatch.getConnector("github-issues"), "mock connector must be registered");
    const created = urlWatch.createUrlWatch({ url, intervalSeconds: 300, prompt: "راقب القضايا", connector: "github-issues" });
    assert.ok(!("error" in created), "connector-backed creation must succeed");
    const stop = urlWatch.startUrlWatchers({
      run: async (o) => { reactions.push(o.prompt); return "task_connector_1"; },
      intervalMs: 20,
      // raw fetcher would only answer when a real poll happens; must not be hit
      fetcher: async () => "" as string,
      dueEverySeconds: 0,
    });
    try {
      await waitFor(() => connectorCalls >= 1);
      const s = db.getSchedule(created.scheduleId)!;
      assert.ok(s.lastWatchHash, "connector content hashed into the store");
      assert.equal(reactions.length, 0, "baseline via connector must not fire");
      // Same connector content again → no fire; connector kind unregistration → no crash
      await waitFor(() => (s.lastWatchCheckedAt ? Date.parse(s.lastWatchCheckedAt) : 0) < (db.getSchedule(created.scheduleId)!.lastWatchCheckedAt ? Date.parse(db.getSchedule(created.scheduleId)!.lastWatchCheckedAt!) : 0));
      assert.equal(reactions.length, 0, "unchanged connector content must not fire");
      stopConnector();
      assert.equal(urlWatch.getConnector("github-issues"), undefined, "unregistration stops feeding the content");
      // The watch itself still exists; the supervisor can also delete it.
      assert.equal(urlWatch.deleteUrlWatch(created.scheduleId), true);
    } finally {
      stop();
    }
  });

  it("watch_url appears in the always-on effective run tool list (MF1 recipe)", async () => {
    const runTools = await import("../runTools.js");
    const registryMod = await import("../../tools/registry.js");
    const loamServices = await import("../../tools/loamServices.js");
    const registry = new registryMod.ToolRegistry();
    registry.registerAll(loamServices.createLoamServiceTools());
    const effective = runTools.mergeAlwaysOnTools({
      resolvedAllow: [],
      registeredTools: registry.names(),
      disabledTools: undefined,
    });
    assert.ok(
      runTools.ALWAYS_ON_TOOLS.includes("watch_url"),
      "watch_url must be in the always-on list",
    );
    assert.ok(effective.includes("watch_url"), "effective run tool list must include watch_url");
  });

  it("github-issues connector maps repo/label to the API with the token header", async () => {
    const prevToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "tok_test";
    let calledUrl = "";
    let calledHeaders: Record<string, string> = {};
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      calledUrl = String(url);
      calledHeaders = init?.headers ?? {};
      return {
        ok: true,
        json: async () => [
          { number: 7, title: "排行 bug", state: "open", updated_at: "2026-10-21T00:00:00Z" },
        ],
      } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      const text = await urlWatch.githubIssuesFetcher({ url: "octo/hello:bug", scheduleId: "sched_x" });
      assert.match(calledUrl, /api\.github\.com\/repos\/octo\/hello\/issues\?labels=bug&/);
      assert.equal(calledHeaders.authorization, "Bearer tok_test");
      assert.match(text, /#7 \[open\] 排行 bug/);
    } finally {
      globalThis.fetch = realFetch;
      if (prevToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prevToken;
    }
  });
});
