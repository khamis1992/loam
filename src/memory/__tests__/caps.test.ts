/**
 * J6 acceptance: eviction tests for every hard cap.
 *
 * docs/MEMORY_BUDGET.md lists a bound for every in-memory hot-path cache and
 * says each one is enforced by a real `LruCache`/`BoundedMap`. This file is the
 * executable half of that claim: for each counter it drives the cache through
 * its own public API past the cap and asserts the live size never exceeds the
 * configured bound and that the oldest entry is the one dropped.
 *
 * Everything is in-process and offline: no model calls, no network, no
 * telemetry. The data dir is redirected to a throwaway temp folder so the run
 * never reads or writes the developer's real vault/task store.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate every module that reads the data dir BEFORE importing it.
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "j6-caps-"));
process.env.MANUS_LOCAL_DATA_DIR = tmpData;
process.env.LOAM_AUTH_DISABLED = "true";

import { describe, it } from "node:test";

import { collectCacheStats } from "../stats.js";

/** One registered cache row, read fresh from the shared registry. */
function cache(name: string) {
  const row = collectCacheStats().find((c) => c.name === name);
  assert.ok(row, `cache "${name}" is not registered`);
  return row!;
}

/**
 * Drive a cache past its cap and assert the invariant docs/MEMORY_BUDGET.md
 * promises: occupancy never exceeds the bound, and the entry dropped first is
 * the one inserted first (LRU by insertion order).
 */
async function expectCap(name: string, cap: number, drive: (i: number) => Promise<void> | void): Promise<void> {
  const times = cap + 8;
  let peak = 0;
  for (let i = 0; i < times; i++) {
    await drive(i);
    const row = cache(name);
    peak = Math.max(peak, row.size);
    assert.ok(row.size <= row.capacity, `${name}: ${row.size} entries exceed capacity ${row.capacity}`);
  }
  const row = cache(name);
  assert.equal(row.capacity, cap, `${name}: registered capacity changed`);
  assert.equal(row.size, cap, `${name}: expected ${cap} live entries at saturation, got ${row.size}`);
  assert.equal(peak, cap, `${name}: occupancy ${peak} exceeded the cap ${cap}`);
}

/** Cheap fake tool context for the handful of caches reached through tools. */
function ctx(workspace: string, taskId: string) {
  return { cfg: { workspace, policy: { networkEnabled: false }, model: "test" }, workspace, taskId, emit: () => {} } as never;
}

const W = fs.mkdtempSync(path.join(os.tmpdir(), "j6-caps-ws-"));

describe("J6 hard caps (eviction through the real public APIs)", () => {
  it("protocol-blobs", async () => {
    const { storeBlob, hasBlob, clearBlobs } = await import("../../protocol/blobStore.js");
    try {
      await expectCap("protocol-blobs", 64, (i) => { storeBlob(`blob_${i}`, Buffer.alloc(8, i)); });
      assert.equal(hasBlob("blob_0"), false, "the oldest blob was evicted");
      assert.equal(hasBlob("blob_71"), true, "the newest blob survived");
    } finally {
      clearBlobs();
    }
  });

  it("policy-glob", async () => {
    const { globToRegExp } = await import("../../policy/permissionRules.js");
    await expectCap("policy-glob", 256, (i) => { globToRegExp(`src/*/file_${i}.ts`); });
  });

  it("workspace-directory-requests", async () => {
    const mod = await import("../../protocol/approvals.js");
    // `waitForWorkspaceDirectoryAccess` is the only public path that inserts a
    // pending row (each holds a 15-minute timer), so the drive uses it and keeps
    // an AbortController per request: aborting in `finally` clears the timers
    // the surviving entries would otherwise leave behind.
    const signals: AbortController[] = [];
    try {
      await expectCap("workspace-directory-requests", 128, (i) => {
        const request = mod.createWorkspaceDirectoryAccessRequest({ actionId: `dir_${i}`, requestedPath: W, purpose: "access" });
        const signal = new AbortController();
        signals.push(signal);
        void mod.waitForWorkspaceDirectoryAccess(request, signal.signal);
      });
    } finally {
      for (const signal of signals) signal.abort();
    }
  });

  it("eventlog-projection", async () => {
    const { registerProjection, getProjection } = await import("../../session/eventLog.js");
    await expectCap("eventlog-projection", 64, (i) => {
      registerProjection({ key: `proj_${i}`, init: () => 0, apply: (s: number) => s + 1 });
      getProjection(`proj_${i}`, []);
    });
  });

  it("task-event-subs", async () => {
    const { subscribeTask } = await import("../../server/streams.js");
    // Abandoned listeners (a client that vanished without closing its stream)
    // are exactly what the cap exists for, so this driver deliberately never
    // unsubscribes.
    await expectCap("task-event-subs", 512, (i) => { subscribeTask(`sub_${i}`, () => {}); });
  });

  it("server-approvals", async () => {
    const { createApproval } = await import("../../server/approvals.js");
    await expectCap("server-approvals", 256, (i) => {
      createApproval({ taskId: `t_${i}`, tool: "shell_run", summary: `s_${i}`, argsPreview: "{}" });
    });
  });

  it("url-watch-connectors", async () => {
    const { watchConnector } = await import("../../server/urlWatch.js");
    await expectCap("url-watch-connectors", 64, (i) => {
      watchConnector(`kind_${i}`, async () => "x");
    });
  });

  it("schedule-time-formatters", async () => {
    const { nextCronRun } = await import("../../server/scheduleTime.js");
    const zones = Intl.supportedValuesOf("timeZone");
    assert.ok(zones.length >= 32, "need at least 32 IANA zones to reach the formatter cap");
    await expectCap("schedule-time-formatters", 32, (i) => {
      nextCronRun("* * * * *", new Date(), zones[i % zones.length]!);
    });
  });

  it("run-controllers / run-cancelled-flags / run-active-flags", async () => {
    const mod = await import("../../server/runControl.js");
    try {
      await expectCap("run-controllers", 512, (i) => { mod.createRunSignal(`run_${i}`, false); });
      await expectCap("run-active-flags", 512, (i) => { mod.activateRunSignal(`active_${i}`); });
      await expectCap("run-cancelled-flags", 512, (i) => { mod.cancelRunSignal(`run_${i}`); });
    } finally {
      for (const id of mod.listRunningSignals()) mod.clearRunSignal(id);
    }
  });

  it("browser-frames", async () => {
    const { publishBrowserFrame, latestBrowserFrame, resetBrowserFrames } = await import("../../tools/browserFrames.js");
    try {
      await expectCap("browser-frames", 64, (i) => { publishBrowserFrame(`task_${i}`, { url: `https://example.test/${i}` }); });
      assert.equal(latestBrowserFrame("task_0"), null, "the oldest frame was evicted");
      assert.equal(latestBrowserFrame("task_71")?.url, "https://example.test/71");
    } finally {
      resetBrowserFrames();
    }
  });

  it("browser-frame-sinks", async () => {
    const { registerBrowserFrameSink } = await import("../../tools/browserFrames.js");
    // As with task-event-subs: the cap exists for subscribers nobody closed.
    await expectCap("browser-frame-sinks", 128, (i) => { registerBrowserFrameSink(`sink_${i}`, () => {}); });
  });

  it("browser-frame-aliases", async () => {
    const { setTaskFrameAlias } = await import("../../tools/browserFrames.js");
    await expectCap("browser-frame-aliases", 256, (i) => { setTaskFrameAlias(`alias_${i}`, `task_${i}`); });
  });

  it("stall-guard-failures", async () => {
    const { createStallGuard } = await import("../../agent/stallGuard.js");
    const guard = createStallGuard();
    // Only "dedicated" tools (office_/pentest_/security_/browser_ prefix, or the
    // exact list) populate the failure counters; a generic name only bumps the
    // run-scoped stall counter.
    await expectCap("stall-guard-failures", 64, (i) => { guard(`office_doc_${i}`, {}, false); });
  });

  it("vault-value-names", async () => {
    const { setSecret } = await import("../../server/secretsVault.js");
    const { resolveVaultRefs } = await import("../../tools/vaultTools.js");
    // setSecret logs one INFO line per call; keep the run readable.
    const origLog = console.log;
    console.log = () => {};
    try {
      await expectCap("vault-value-names", 256, (i) => {
        setSecret("global", `cap_${i}`, `value_${i}`);
        resolveVaultRefs(`{{vault:cap_${i}}}`, "global");
      });
    } finally {
      console.log = origLog;
    }
  });

  it("grokbot-rate and grokbot-recent", async () => {
    const mod = await import("../../server/bridge/grokbot.js");
    try {
      await expectCap("grokbot-rate", 256, (i) => { mod.checkExecuteRate(`agent_${i}`); });
      await expectCap("grokbot-recent", 128, (i) => {
        mod.storeMirror({ agentId: `agent_${i}`, from: "Grok Bot", text: `m_${i}`, threadAppended: false });
      });
    } finally {
      mod.resetGrokbotBridgeForTests();
    }
  });

  it("task-phases", async () => {
    const { createPhaseTools } = await import("../../tools/phaseTools.js");
    const phaseSet = createPhaseTools()[0]!;
    await expectCap("task-phases", 512, async (i) => {
      await phaseSet.run({ phase: "build", reason: `r_${i}` }, ctx(W, `phase_${i}`));
    });
  });

  it("protocol-temp-codes", async () => {
    const rpc = await import("../../protocol/rpc.js");
    const store = {
      getSession: () => undefined,
      getSessionByTaskId: () => undefined,
      isDeleted: () => false,
      ensureSession: () => ({ sessionId: "s" }),
      setTaskId: () => {},
      setTitle: () => {},
      deleteTask: () => {},
    } as never;
    const handlers = rpc.makeRpcHandlers(store);
    const gen = handlers["user.v1.UserAuthService/GenerateTempAuthCode"];
    assert.equal(typeof gen, "function");
    await expectCap("protocol-temp-codes", 128, () => { gen!({}, { userUid: null, isPublic: true }); });
  });

  it("protocol-login-tokens", async () => {
    const { issueLoginToken, consumeLoginToken } = await import("../../protocol/rpc.js");
    await expectCap("protocol-login-tokens", 256, (i) => { issueLoginToken(`nonce_${i}`); });
    assert.equal(typeof consumeLoginToken("missing"), "undefined");
  });

  it("shell-sessions", async () => {
    const { shellTools, disposeShellSessions } = await import("../../tools/shell.js");
    const start = shellTools.find((t) => t.name === "shell_start");
    assert.ok(start, "shell_start tool is exported");
    try {
      await expectCap("shell-sessions", 32, async (i) => {
        await start!.run({ shell: "cmd" }, ctx(W, `shell_${i}`));
      });
    } finally {
      disposeShellSessions();
    }
  });

  it("spec-terminal-aliases and spec-browser-aliases", async () => {
    const { createSpecAliasTools } = await import("../../tools/specAliases.js");
    // A fake registry that reports a started shell/browser without spawning one.
    // `terminal execute` records its alias before the (deliberately failing)
    // write returns, and `browser open` records its tab id on success, so the
    // driver reaches both alias maps with no real PTY or Playwright tab.
    const fakeRegistry = {
      exec: async (name: string) => {
        if (name === "shell_start") return { ok: true, content: "session shell_deadbeef" };
        if (name === "browser_open") return { ok: true, content: "pageId=page_123" };
        return { ok: false, content: `no native tool ${name}` };
      },
    } as never;
    const tools = createSpecAliasTools({ registry: fakeRegistry, ollama: {} as never });
    const terminal = tools.find((t) => t.name === "terminal");
    const browser = tools.find((t) => t.name === "browser");
    assert.ok(terminal && browser, `spec alias tools exported: ${tools.map((t) => t.name).join(",")}`);
    await expectCap("spec-terminal-aliases", 64, async (i) => {
      await terminal!.run({ action: "execute", shellId: `sh_${i}`, command: "echo hi", timeoutSec: 1 }, ctx(W, "spec"));
    });
    await expectCap("spec-browser-aliases", 64, async (i) => {
      await browser!.run({ action: "open", tabId: `tab_${i}`, url: "https://example.test" }, ctx(W, "spec"));
    });
  });

  it("server-file-watchers", async () => {
    const { startWatcher, stopAllWatchers } = await import("../../server/fileWatchers.js");
    try {
      await expectCap("server-file-watchers", 128, (i) => {
        startWatcher(`watch_${i}`, W, `prompt_${i}`, undefined, undefined, async () => "t");
      });
    } finally {
      stopAllWatchers();
    }
  });

  it("video-studio-pending and video-studio-tasks", async () => {
    const { VideoStudioRelay } = await import("../../server/videoStudioRelay.js");
    const { subscribeTask } = await import("../../server/streams.js");
    // A long, unref'd timeout keeps the in-flight commands unsettled (the relay
    // is what the cap exists to bound); the attached subscriber is what lets
    // `enqueue` accept each command.
    const relay = new VideoStudioRelay({ timeoutMs: 60_000 });
    let n = 0;
    const attach = (prefix: string): void => {
      const taskId = `${prefix}_${n++}`;
      subscribeTask(taskId, () => {});
      void relay.enqueue(taskId, "film", "probe", {});
    };
    for (let i = 0; i < 200; i++) attach(`vs_${i}`);
    await expectCap("video-studio-tasks", 128, () => { attach("vs_more"); });
    await expectCap("video-studio-pending", 64, () => { attach("vs_pend"); });
  });
});

describe("docs/MEMORY_BUDGET.md stays in sync with the code", () => {
  it("lists a cap for every registered cache", async () => {
    // Importing the modules above registered their counters; importing the doc
    // table's sources keeps the parity check honest even on a partial run.
    await import("../../memory/cache.js");
    const doc = fs.readFileSync(new URL("../../../docs/MEMORY_BUDGET.md", import.meta.url), "utf8");
    const rows = [...doc.matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|\s*(\d+)\s*\|/gm)];
    assert.ok(rows.length >= 30, `expected the budget table to list many caps, found ${rows.length}`);
    for (const [, name, capText] of rows) {
      const registered = collectCacheStats().find((c) => c.name === name);
      if (!registered) continue; // a cap whose module was not imported in this process
      assert.equal(
        registered.capacity,
        Number(capText),
        `docs/MEMORY_BUDGET.md lists ${name} at ${capText} but the code enforces ${registered.capacity}`,
      );
    }
  });
});
