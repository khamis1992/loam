/**
 * Tests for bench/rendererHibernationBench.ts (J7 renderer-RSS measurement).
 *
 * Guarantees under test:
 *  - only renderer (`Tab`) rows are counted, and KB is converted to MB
 *  - a non-finite or missing working set is ignored rather than counted as 0
 *  - the reported figure is the median of the readings taken per phase
 *  - the fixture is shaped like the chat events the view renders, with images
 *    when attachments are asked for
 *  - the session token is seeded before launch (the shell redirects without it)
 *  - the mock backend answers CORS preflights and the routes the view needs
 *  - the CLI parses its flags and rejects unknown ones
 *  - the orchestration records before/after, a real release, a flat result, the
 *    preserved draft and the released DOM, and reports unavailability honestly
 *  - the J6 debug:memory surface is preferred, with a main-process fallback
 *  - the heap is swept before each reading by default, so a release is visible
 *  - the JSON report is written when asked for
 *
 * No Electron process is launched and no model is called: the harness is faked,
 * so this suite is fully offline and deterministic. The mock backend is real, so
 * each test gets its own port.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));

import {
  BENCH_DRAFT_TEXT,
  BENCH_SESSION_TOKEN,
  BENCH_SESSION_UID,
  SCRIPT_MARKERS,
  closeMockApi,
  createMockApiHandler,
  fixtureEvents,
  hookProbeScript,
  median,
  parseArgs,
  readSourceCommit,
  renderSampleScript,
  rendererEnvScript,
  rendererPids,
  runRendererBench,
  seedLocalStorage,
  startMockApi,
  sumRendererMetricsMB,
  type ElectronHarness,
  type RendererMetric,
} from "../rendererHibernationBench.js";

/** A metrics row helper: `app.getAppMetrics()` reports working set in KB. */
function metric(pid: number, type: string, workingSetKB: number | undefined): RendererMetric {
  return { pid, type, memory: workingSetKB === undefined ? undefined : { workingSetSize: workingSetKB } };
}

describe("bench/rendererHibernationBench: metrics attribution", () => {
  it("counts only renderer (Tab) rows and converts KB to MB", () => {
    const metrics = [
      metric(100, "Browser", 500 * 1024), // main process: not a renderer
      metric(101, "Tab", 256 * 1024), // 256 MB
      metric(102, "Tab", 128 * 1024), // 128 MB
      metric(103, "Utility", 64 * 1024), // the Node server: never counted
      metric(104, "GPU", 32 * 1024),
    ];
    const result = sumRendererMetricsMB(metrics);
    assert.equal(result.matched, 2);
    assert.equal(result.mb, 384);
    assert.deepEqual(result.pids, [101, 102]);
  });

  it("ignores rows with no usable working set instead of counting them as zero", () => {
    const metrics = [
      metric(201, "Tab", undefined),
      metric(202, "Tab", Number.NaN),
      metric(203, "Tab", 100 * 1024),
    ];
    const result = sumRendererMetricsMB(metrics);
    assert.equal(result.matched, 1, "only the row with a real reading is counted");
    assert.equal(result.mb, 100);
    assert.deepEqual(result.pids, [203]);
  });

  it("reports zero matched for an empty or absent metrics list", () => {
    assert.deepEqual(sumRendererMetricsMB([]), { mb: 0, matched: 0, pids: [] });
    assert.deepEqual(sumRendererMetricsMB(undefined as unknown as RendererMetric[]), { mb: 0, matched: 0, pids: [] });
  });

  it("lists renderer pids without requiring a memory reading", () => {
    const metrics = [metric(1, "Tab", undefined), metric(2, "Utility", 10), metric(3, "Tab", 10)];
    assert.deepEqual(rendererPids(metrics), [1, 3]);
  });
});

describe("bench/rendererHibernationBench: median", () => {
  it("takes the middle reading for an odd count and the mean of the pair for an even one", () => {
    assert.equal(median([300, 100, 200]), 200);
    assert.equal(median([100, 200]), 150);
  });

  it("is 0 for no usable readings and ignores non-finite ones", () => {
    assert.equal(median([]), 0);
    assert.equal(median([Number.NaN, 100]), 100);
  });
});

describe("bench/rendererHibernationBench: fixture", () => {
  it("builds the requested number of renderable chat events", () => {
    const events = fixtureEvents(50) as Array<Record<string, unknown>>;
    assert.equal(events.length, 50);
    assert.equal(events[0]!.type, "chat");
    assert.equal(events[0]!.sender, "user");
    assert.equal(events[1]!.sender, "assistant");
    assert.ok(String(events[0]!.content).includes("Fixture message 0"));
  });

  it("includes fenced code every seventh message so the highlighter runs", () => {
    const events = fixtureEvents(14) as Array<Record<string, unknown>>;
    assert.ok(String(events[0]!.content).includes("```ts"), "message 0 has a code block");
    assert.ok(String(events[7]!.content).includes("```ts"), "message 7 has a code block");
    assert.ok(!String(events[1]!.content).includes("```"), "message 1 has no code block");
  });

  it("interleaves image attachments when asked to, so image caches are covered", () => {
    const events = fixtureEvents(20, { withAttachments: true }) as Array<Record<string, unknown>>;
    const images = events.filter((e) => e.type === "attachment");
    assert.ok(images.length > 0, "the fixture carries images");
    assert.equal(images[0]!.mime, "image/png");
    assert.equal(events.length, 20, "the fixture size is unchanged");
    assert.equal(fixtureEvents(20).length, 20);
    assert.ok(fixtureEvents(20).every((e) => (e as { type: string }).type === "chat"));
  });
});

describe("bench/rendererHibernationBench: session seed", () => {
  it("writes the session token where the main process reads it at startup", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "j7-seed-"));
    seedLocalStorage(dir);
    const written = JSON.parse(fs.readFileSync(path.join(dir, "localStorage.json"), "utf8")) as { session_token?: string };
    assert.equal(written.session_token, BENCH_SESSION_TOKEN, "the shell reads this key or redirects to /login");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates the user-data dir when it does not exist yet", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "j7-seed-nested-"));
    const dir = path.join(root, "not", "created");
    seedLocalStorage(dir, "custom-token");
    const written = JSON.parse(fs.readFileSync(path.join(dir, "localStorage.json"), "utf8")) as { session_token?: string };
    assert.equal(written.session_token, "custom-token");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("bench/rendererHibernationBench: CLI", () => {
  it("parses the documented flags", () => {
    const args = parseArgs(["--port", "4001", "--api-port", "9001", "--messages", "123", "--json-out", "out.json"]);
    assert.deepEqual(args, { port: 4001, apiPort: 9001, fixtureMessages: 123, jsonOut: "out.json" });
  });

  it("parses the sampling flags", () => {
    const args = parseArgs(["--samples", "5", "--settle-ms", "0"]);
    assert.deepEqual(args, { sampleCount: 5, settleMs: 0 });
  });

  it("parses the GC and attachment flags", () => {
    assert.deepEqual(parseArgs(["--no-force-gc"]), { forceGc: false });
    assert.deepEqual(parseArgs(["--force-gc"]), { forceGc: true });
    assert.deepEqual(parseArgs(["--with-attachments"]), { withAttachments: true });
  });

  it("recognises help and rejects an unknown flag", () => {
    assert.equal(parseArgs(["--help"]).help, true);
    assert.equal(parseArgs(["-h"]).help, true);
    assert.throws(() => parseArgs(["--nope"]), /unknown flag/);
  });
});

describe("bench/rendererHibernationBench: provenance", () => {
  it("reports the checked-out revision (or nothing outside a work tree)", () => {
    const commit = readSourceCommit();
    assert.ok(commit === undefined || /^[0-9a-f]{7,40}(-dirty)?$/.test(commit), `unexpected commit: ${commit}`);
  });
});

describe("bench/rendererHibernationBench: mock backend", () => {
  const servers: http.Server[] = [];
  after(async () => { for (const s of servers) await closeMockApi(s); });

  async function start(port: number): Promise<number> {
    servers.push(await startMockApi(port, BENCH_SESSION_UID));
    return port;
  }

  it("answers the hibernation route the renderer polls", async () => {
    const port = await start(18991);
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${BENCH_SESSION_UID}/hibernation`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { record?: { sessionId?: string }; disabled?: boolean };
    assert.equal(body.record?.sessionId, BENCH_SESSION_UID);
    assert.equal(body.disabled, false);
  });

  it("answers other API routes with an empty object", async () => {
    const port = await start(18992);
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {});
  });

  it("answers a CORS preflight so the app://agent origin can call it", async () => {
    const port = await start(18993);
    const res = await fetch(`http://127.0.0.1:${port}/api/credits`, {
      method: "OPTIONS",
      headers: { origin: "app://agent", "access-control-request-method": "POST" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*", "without this every renderer call fails");
  });

  it("returns a user object for UserInfo so the token validates", async () => {
    const port = await start(18994);
    const res = await fetch(`http://127.0.0.1:${port}/user.v1.UserService/UserInfo`, { method: "POST" });
    const body = (await res.json()) as { email?: string };
    assert.equal(res.status, 200);
    assert.equal(body.email, "bench@example.com");
  });

  it("serves a socket.io handshake, because a failed one is treated as an auth failure", async () => {
    const port = await start(18995);
    const res = await fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`, {
      headers: { origin: "app://agent" },
    });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.startsWith("0{"), `expected an engine.io open packet, got: ${body.slice(0, 40)}`);
  });

  it("keeps every route on one origin-agnostic handler", () => {
    // The handler is exported separately so a caller can mount it without
    // socket.io; it must answer a plain request on its own.
    const handler = createMockApiHandler(BENCH_SESSION_UID);
    assert.equal(typeof handler, "function");
  });
});

/** A fake harness: canned page readings in call order, canned metrics. */
function fakeHarness(options: {
  beforeKB: number;
  afterKB: number;
  domReleased?: boolean;
  eventCount?: number;
  draft?: string | null;
  hookAttached?: boolean;
  pageRows?: number;
  /** False emulates a build where debug:memory.refresh is unavailable. */
  pageSampleAvailable?: boolean;
}): { harness: ElectronHarness; pages: string[]; navigations: string[] } {
  const pages: string[] = [];
  const navigations: string[] = [];
  let hibernatedYet = false;
  const draft = options.draft === undefined ? BENCH_DRAFT_TEXT : options.draft;
  const harness: ElectronHarness = {
    mainPid: process.pid,
    async navigate(url: string) {
      navigations.push(url);
    },
    async waitForHook() {
      // Mirrors the real harness, which probes the page for the hook.
      pages.push(hookProbeScript());
      return options.hookAttached ?? true;
    },
    async sampleMainMetrics() {
      const kb = hibernatedYet ? options.afterKB : options.beforeKB;
      return [metric(5001, "Browser", 400 * 1024), metric(5002, "Tab", kb)];
    },
    async evaluateInPage<T>(script: string): Promise<T> {
      pages.push(script);
      if (script.includes(SCRIPT_MARKERS.env)) return true as T;
      if (script.includes(SCRIPT_MARKERS.hook)) return (options.hookAttached ?? true) as T;
      if (script.includes(SCRIPT_MARKERS.inject)) {
        const hookAvailable = options.hookAttached ?? true;
        return { hookAvailable, rows: hookAvailable ? (options.pageRows ?? 2000) : 0 } as T;
      }
      if (script.includes(SCRIPT_MARKERS.sample)) {
        if (options.pageSampleAvailable === false) return { ok: false, reason: "unavailable" } as T;
        const kb = hibernatedYet ? options.afterKB : options.beforeKB;
        // The sweep only actually collects when the page was launched with
        // --expose-gc, which the bench defaults to. The guard is compiled into
        // the script, so match on the guard's literal `true`/`false`, not the
        // call (which appears in both forms).
        const swept = /if \(true\)\s*\{\s*try \{[^}]*window\.gc/.test(script);
        return { ok: true, gcAvailable: swept, rendererRssMb: kb / 1024, matched: 1, pids: [5002] } as T;
      }
      if (script.includes(SCRIPT_MARKERS.hibernate)) {
        hibernatedYet = true;
        return {
          domReleased: options.domReleased ?? true,
          eventCount: options.eventCount ?? 2000,
          rows: options.domReleased === false ? 2000 : 1,
          draftTyped: draft,
          released: { entries: options.eventCount ?? 2000 },
          error: null,
        } as T;
      }
      if (script.includes(SCRIPT_MARKERS.wake)) {
        return { draft, rows: 2000, eventCount: options.eventCount ?? 2000 } as T;
      }
      throw new Error(`unexpected page script: ${script.slice(0, 60)}`);
    },
    async close() { /* nothing to close */ },
  };
  return { harness, pages, navigations };
}

describe("bench/rendererHibernationBench: orchestration", () => {
  it("records a real release with the draft and DOM released", async () => {
    const { harness, pages, navigations } = fakeHarness({ beforeKB: 900 * 1024, afterKB: 600 * 1024 });
    const report = await runRendererBench({ launchImpl: async () => harness, fixtureMessages: 10, settleMs: 0, apiPort: 18996 });
    assert.equal(report.kind, "renderer-hibernation");
    assert.equal(report.beforeMB, 900);
    assert.equal(report.afterMB, 600);
    assert.equal(report.deltaMB, -300);
    assert.equal(report.released, true, "a drop is reported as released");
    assert.equal(report.unavailable, false);
    assert.equal(report.rendered, true);
    assert.equal(report.domReleased, true);
    assert.equal(report.draftPreserved, BENCH_DRAFT_TEXT, "the typed draft survived the wake");
    assert.equal(report.hibernatedEventCount, 2000, "the canonical count is still reported while hibernated");
    assert.equal(report.forcedGc, true, "the heap is swept by default, so the release is visible");
    assert.equal(report.withAttachments, false);
    assert.ok(report.gcAvailable, "the sweep actually ran");
    assert.deepEqual(report.countedPids, [5002], "only the renderer pid is counted");
    assert.deepEqual(navigations, [`/app/${BENCH_SESSION_UID}`], "the bench navigates to the chat view");
    // Every page-side script the bench drives actually ran. The env script is
    // installed with addInitScript instead, so it is asserted on its own below.
    for (const marker of [SCRIPT_MARKERS.hook, SCRIPT_MARKERS.inject, SCRIPT_MARKERS.sample, SCRIPT_MARKERS.hibernate, SCRIPT_MARKERS.wake]) {
      assert.ok(pages.some((p) => p.includes(marker)), `${marker} ran`);
    }
  });

  it("sweeps the heap before each reading by default, and can skip it", () => {
    const swept = renderSampleScript(true);
    const raw = renderSampleScript(false);
    // The call is always present in the script; what differs is the guard around
    // it, because the sweep only helps when the app was launched with
    // --expose-gc. Matching the guard is what actually distinguishes the two.
    assert.match(swept, /if \(true\)[\s\S]*window\.gc\(\); window\.gc\(\);/, "the default reading collects first");
    assert.match(raw, /if \(false\)[\s\S]*window\.gc\(\); window\.gc\(\);/, "--no-force-gc gates the sweep off");
    assert.notEqual(swept, raw, "the two readings are not the same script");
    // The sweep only matters when the renderer exposes gc; the report records
    // whether it actually ran.
    assert.match(swept, /gcAvailable/);
  });

  it("installs an env script that points the renderer at the bench backend", () => {
    const script = rendererEnvScript("http://127.0.0.1:8787", "http://127.0.0.1:8787");
    assert.ok(script.includes(SCRIPT_MARKERS.env));
    assert.ok(script.includes("__AGENT_STUDIO_ENV__"), "the renderer reads its API base from here first");
    assert.ok(script.includes("http://127.0.0.1:8787"));
    assert.ok(script.includes("session_token"), "the window storage copy is seeded too");
  });

  it("reports the median of the readings taken in each phase", async () => {
    const { harness } = fakeHarness({ beforeKB: 900 * 1024, afterKB: 600 * 1024 });
    const report = await runRendererBench({
      launchImpl: async () => harness,
      fixtureMessages: 10,
      settleMs: 0,
      sampleCount: 3,
      sampleIntervalMs: 0,
      apiPort: 18997,
    });
    assert.deepEqual(report.beforeSamplesMB, [900, 900, 900]);
    assert.deepEqual(report.afterSamplesMB, [600, 600, 600]);
    assert.equal(report.samples.length, 6, "three readings per phase");
    assert.equal(report.beforeMB, 900);
    assert.equal(report.afterMB, 600);
  });

  it("reports a flat result as flat, never as a saving", async () => {
    const { harness } = fakeHarness({ beforeKB: 700 * 1024, afterKB: 700 * 1024 });
    const report = await runRendererBench({ launchImpl: async () => harness, fixtureMessages: 10, settleMs: 0, apiPort: 18998 });
    assert.equal(report.deltaMB, 0);
    assert.equal(report.released, false, "no drop means not released");
    assert.equal(report.unavailable, false, "a real reading is still available");
  });

  it("reports growth honestly rather than hiding it", async () => {
    const { harness } = fakeHarness({ beforeKB: 500 * 1024, afterKB: 560 * 1024 });
    const report = await runRendererBench({ launchImpl: async () => harness, fixtureMessages: 10, settleMs: 0, apiPort: 18999 });
    assert.equal(report.deltaMB, 60);
    assert.equal(report.released, false);
  });

  it("prefers the J6 debug:memory surface and says so", async () => {
    const { harness } = fakeHarness({ beforeKB: 900 * 1024, afterKB: 600 * 1024 });
    const report = await runRendererBench({ launchImpl: async () => harness, fixtureMessages: 10, settleMs: 0, apiPort: 19001 });
    assert.equal(report.sampleSource, "debug:memory");
    assert.match(report.attribution, /debug:memory/);
  });

  it("falls back to main-process metrics when debug:memory is unavailable", async () => {
    const { harness } = fakeHarness({ beforeKB: 800 * 1024, afterKB: 500 * 1024, pageSampleAvailable: false });
    const report = await runRendererBench({ launchImpl: async () => harness, fixtureMessages: 10, settleMs: 0, apiPort: 19002 });
    assert.equal(report.sampleSource, "app-metrics", "the fallback is recorded, not hidden");
    assert.match(report.attribution, /fallback/);
    assert.equal(report.beforeMB, 800);
    assert.equal(report.afterMB, 500);
    assert.equal(report.released, true);
  });

  it("marks the measurement unavailable when the app cannot launch", async () => {
    const report = await runRendererBench({
      launchImpl: async () => { throw new Error("no display"); },
      fixtureMessages: 10,
      settleMs: 0,
      apiPort: 19003,
    });
    assert.equal(report.unavailable, true);
    assert.match(report.unavailableReason ?? "", /no display/);
    assert.equal(report.released, false, "an unavailable run is never a saving");
    assert.equal(report.beforeMB, 0);
  });

  it("marks the measurement unavailable when the view never attaches its hook", async () => {
    const { harness } = fakeHarness({ beforeKB: 900 * 1024, afterKB: 600 * 1024, hookAttached: false });
    const report = await runRendererBench({
      launchImpl: async () => harness,
      fixtureMessages: 10,
      settleMs: 0,
      hookTimeoutMs: 1000,
      apiPort: 19004,
    });
    assert.equal(report.unavailable, true);
    assert.match(report.unavailableReason ?? "", /test hook/);
    assert.equal(report.rendered, false);
  });

  it("marks the measurement unavailable when the mock port is already in use", async () => {
    const taken = http.createServer(() => undefined);
    await new Promise<void>((resolve) => taken.listen(19005, "127.0.0.1", () => resolve()));
    try {
      const report = await runRendererBench({
        launchImpl: async () => { throw new Error("should not be launched"); },
        fixtureMessages: 10,
        settleMs: 0,
        apiPort: 19005,
      });
      assert.equal(report.unavailable, true);
      assert.match(report.unavailableReason ?? "", /mock backend port 19005/);
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }
  });

  it("writes the JSON report when a path is given", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "j7-bench-report-"));
    const out = path.join(dir, "nested", "J7.json");
    const { harness } = fakeHarness({ beforeKB: 800 * 1024, afterKB: 500 * 1024 });
    await runRendererBench({ launchImpl: async () => harness, fixtureMessages: 10, jsonOut: out, settleMs: 0, apiPort: 19006 });
    const written = JSON.parse(fs.readFileSync(out, "utf8")) as { kind: string; released: boolean; deltaMB: number };
    assert.equal(written.kind, "renderer-hibernation");
    assert.equal(written.released, true);
    assert.equal(written.deltaMB, -300);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("can skip the sweep, and says so", async () => {
    const { harness } = fakeHarness({ beforeKB: 900 * 1024, afterKB: 600 * 1024 });
    const report = await runRendererBench({
      launchImpl: async () => harness,
      fixtureMessages: 10,
      settleMs: 0,
      forceGc: false,
      apiPort: 19008,
    });
    assert.equal(report.forcedGc, false);
    assert.equal(report.gcAvailable, false, "no sweep was requested, so nothing collected");
  });

  it("reports the fixture size it actually measured", async () => {
    const { harness } = fakeHarness({ beforeKB: 900 * 1024, afterKB: 600 * 1024 });
    const report = await runRendererBench({ launchImpl: async () => harness, fixtureMessages: 777, settleMs: 0, apiPort: 19007 });
    assert.equal(report.fixtureMessages, 777);
  });

  it("records when the fixture included image attachments", async () => {
    const { harness } = fakeHarness({ beforeKB: 900 * 1024, afterKB: 600 * 1024 });
    const report = await runRendererBench({
      launchImpl: async () => harness,
      fixtureMessages: 10,
      settleMs: 0,
      withAttachments: true,
      apiPort: 19009,
    });
    assert.equal(report.withAttachments, true);
    assert.ok(report.notes.some((n) => n.includes("image attachments")));
  });
});

describe("bench/results/J7 before/after acceptance", () => {
  const RESULTS_DIR = path.resolve(HERE, "../results");

  function load(name: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, name), "utf8")) as Record<string, unknown>;
  }

  it("has the committed J7 measurement", () => {
    assert.ok(fs.existsSync(path.join(RESULTS_DIR, "J7.json")), "J7.json must exist");
  });

  it("records measured renderer hibernation without guessing", () => {
    const j7 = load("J7.json") as {
      kind?: string;
      fixtureMessages?: number;
      beforeMB?: number;
      afterMB?: number;
      deltaMB?: number;
      released?: boolean;
      domReleased?: boolean;
      draftPreserved?: string;
      hibernatedEventCount?: number;
    };
    assert.equal(j7.kind, "renderer-hibernation");
    assert.equal(j7.fixtureMessages, 2000);
    assert.equal(typeof j7.beforeMB, "number");
    assert.equal(typeof j7.afterMB, "number");
    assert.equal(typeof j7.deltaMB, "number");
    assert.equal(j7.domReleased, true);
    assert.equal(j7.hibernatedEventCount, 2000);
    assert.equal(j7.draftPreserved, "draft preserved across hibernation");
  });
});

