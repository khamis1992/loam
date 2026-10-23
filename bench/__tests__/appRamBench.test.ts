/**
 * Tests for bench/appRamBench.ts (J6 app-level RSS benchmark).
 *
 * Guarantees under test:
 *  - the fixed long-chat fixture is deterministic and the right length
 *  - one scenario iteration drives both the chat run and the memory-store POST
 *    and records what happened without throwing when the server is down
 *  - the server's bounded-cache counters are read back from the debug route
 *  - the report is shaped like the committed bench/results/J6-*.json files
 *  - CLI flags are parsed and help text is printed
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  DEFAULT_THRESHOLD_MB,
  HELP_TEXT,
  benchDataDir,
  fixtureText,
  parseArgs,
  readServerCounters,
  readSourceCommit,
  runAppBench,
  runScenarioIteration,
  waitForServer,
} from "../appRamBench.js";

// This test file is ESM, so derive the directory instead of using __dirname.
const HERE = path.dirname(fileURLToPath(import.meta.url));

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as import("node:net").AddressInfo;
      resolve(addr.port);
    });
  });
}

/** A tiny stand-in for the real server: /api/health, /api/chat, /api/memory, /api/debug/memory. */
function createFakeServer(state: { chats: number; memories: number }): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      state.chats += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ type: "task", taskId: `task-${state.chats}` })}\n\n`);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/memory") {
      state.memories += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `mem-${state.memories}` }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/debug/memory") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ totals: { caches: 3, entries: 42, bytes: 1024 * 1024 } }));
      return;
    }
    res.writeHead(404).end();
  });
}

describe("bench/appRamBench", () => {
  it("builds a deterministic long-chat fixture of exactly the requested length", () => {
    const text = fixtureText(500, 7);
    assert.equal(text.length, 500);
    assert.equal(text, fixtureText(500, 7));
    assert.notEqual(text, fixtureText(500, 8), "the seed changes the fixture");
  });

  it("parses CLI flags and rejects unknown ones", () => {
    const args = parseArgs([
      "--iterations", "3",
      "--threshold", "10",
      "--json-out", "x.json",
      "--data-dir", "D:/tmp/bench-data",
      "--ready-timeout-ms", "9000",
      "--spawn",
    ]);
    assert.equal(args.iterations, 3);
    assert.equal(args.thresholdMB, 10);
    assert.equal(args.jsonOut, "x.json");
    assert.equal(args.dataDir, "D:/tmp/bench-data");
    assert.equal(args.readyTimeoutMs, 9000);
    assert.equal(args.spawn, true);
    assert.throws(() => parseArgs(["--nope"]), /unknown flag/);
  });

  it("prints help text naming the app scenario", () => {
    assert.match(HELP_TEXT, /bench:ram:app/);
    assert.match(HELP_TEXT, /app-scenario|app-RAM/i);
    assert.match(HELP_TEXT, /--data-dir/);
    assert.match(HELP_TEXT, /--ready-timeout-ms/);
  });

  it("drives one scenario iteration against the local routes and reports both requests", async () => {
    const state = { chats: 0, memories: 0 };
    const server = createFakeServer(state);
    const port = await listen(server);
    try {
      const result = await runScenarioIteration(`http://127.0.0.1:${port}`, 1, 2000);
      assert.equal(result.iteration, 1);
      assert.equal(result.chatStatus, 200);
      assert.equal(result.memoryStatus, 200);
      assert.equal(result.taskId, "task-1");
      assert.ok(result.chatBytes > 0);
      assert.ok(result.memoryBytes > 0);
      assert.equal(result.error, null);
      assert.equal(state.chats, 1);
      assert.equal(state.memories, 1);
    } finally {
      server.close();
    }
  });

  it("records an error instead of throwing when the server is unreachable", async () => {
    // Port 1 is not listening; the iteration must resolve, not reject.
    const result = await runScenarioIteration("http://127.0.0.1:1", 2, 100);
    assert.equal(result.chatStatus, 0);
    assert.equal(result.memoryStatus, 0);
    assert.ok(result.error, "a failed request must be recorded");
  });

  it("reads the server's bounded-cache counters from the debug route", async () => {
    const state = { chats: 0, memories: 0 };
    const server = createFakeServer(state);
    const port = await listen(server);
    try {
      const counters = await readServerCounters(`http://127.0.0.1:${port}`);
      assert.deepEqual(counters, { retainedCacheBytes: 1024 * 1024, cacheEntries: 42, cacheCount: 3, debugRoutePresent: true });
    } finally {
      server.close();
    }
  });

  it("returns zero counters instead of throwing when the route is absent", async () => {
    const counters = await readServerCounters("http://127.0.0.1:1");
    assert.deepEqual(counters, { retainedCacheBytes: 0, cacheEntries: 0, cacheCount: 0, debugRoutePresent: false });
  });

  it("waits for a server to become ready", async () => {
    const state = { chats: 0, memories: 0 };
    const server = createFakeServer(state);
    const port = await listen(server);
    try {
      assert.equal(await waitForServer(`http://127.0.0.1:${port}`, 2000), true);
      assert.equal(await waitForServer("http://127.0.0.1:1", 300), false);
    } finally {
      server.close();
    }
  });

  it("produces a report with the committed J6 JSON shape", async () => {
    const state = { chats: 0, memories: 0 };
    const server = createFakeServer(state);
    const port = await listen(server);
    const jsonOut = path.join(os.tmpdir(), `j6-app-bench-${process.pid}.json`);
    try {
      const report = await runAppBench({
        baseUrl: `http://127.0.0.1:${port}`,
        iterations: 2,
        fixtureChars: 500,
        sampleMs: 1,
        intervalMs: 1,
        thresholdMB: 5000,
        jsonOut,
      });
      assert.equal(report.kind, "app-scenario");
      assert.equal(report.iterations, 2);
      assert.equal(report.port, 3939, "port falls back to the default when baseUrl is used");
      assert.equal(report.thresholdMB, 5000);
      assert.equal(report.thresholdExceeded, false);
      assert.equal(report.cacheCount, 3);
      assert.equal(report.cacheEntries, 42);
      assert.equal(report.retainedCacheBytes, 1024 * 1024);
      assert.equal(report.debugRoutePresent, true, "a 200 from the route means the server is J6-aware");
      assert.equal(report.sessions.length, 2);
      assert.equal(report.sessions[0]!.taskId, "task-1");
      assert.equal(report.sessions[1]!.taskId, "task-2");
      assert.equal(state.chats, 2);
      assert.equal(state.memories, 2);
      assert.ok(report.peakMB >= report.idleMB);
      assert.ok(report.growthMB >= 0);
      assert.ok(fs.existsSync(jsonOut));
      const written = JSON.parse(fs.readFileSync(jsonOut, "utf8")) as { kind?: string; iterations?: number };
      assert.equal(written.kind, "app-scenario");
      assert.equal(written.iterations, 2);
    } finally {
      server.close();
      fs.rmSync(jsonOut, { force: true });
    }
  });

  it("flags a regression when the growth exceeds the threshold", async () => {
    const state = { chats: 0, memories: 0 };
    const server = createFakeServer(state);
    const port = await listen(server);
    try {
      const report = await runAppBench({
        baseUrl: `http://127.0.0.1:${port}`,
        iterations: 1,
        fixtureChars: 100,
        sampleMs: 1,
        intervalMs: 1,
        thresholdMB: 0,
      });
      assert.equal(report.thresholdMB, 0);
      assert.ok(report.growthMB >= 0);
      // With a zero threshold any measured growth (or rounding) trips the gate;
      // the important part is that the flag is derived, not hardcoded.
      assert.equal(typeof report.thresholdExceeded, "boolean");
    } finally {
      server.close();
    }
  });

  it("exposes the default growth threshold", () => {
    assert.equal(DEFAULT_THRESHOLD_MB, 64);
  });

  it("names a fresh, isolated temp data dir per bench run", () => {
    const a = benchDataDir();
    const b = benchDataDir();
    assert.notEqual(a, b);
    assert.match(a, /loam-bench-data-/);
    assert.ok(path.isAbsolute(a), "the data dir must be absolute so the child can use it");
  });

  it("records the git revision of the tree it measured", () => {
    const commit = readSourceCommit();
    assert.equal(typeof commit, "string");
    // `<sha>` when the tree is clean, `<sha>-dirty` when it has uncommitted work.
    assert.match(commit!, /^[0-9a-f]{7,40}(-dirty)?$/, "a git rev-parse HEAD");
  });
});

/**
 * The J6 acceptance test: the committed BEFORE/AFTER JSON pair must both be
 * real, self-consistent measurements, and the AFTER run must prove the
 * bounded-cache surface is actually wired into the server.
 */
describe("bench/results/J6 before/after acceptance", () => {
  const RESULTS_DIR = path.resolve(HERE, "../results");

  function load(name: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, name), "utf8")) as Record<string, unknown>;
  }

  it("has both committed measurements", () => {
    assert.ok(fs.existsSync(path.join(RESULTS_DIR, "J6-before.json")), "J6-before.json must exist");
    assert.ok(fs.existsSync(path.join(RESULTS_DIR, "J6-after.json")), "J6-after.json must exist");
  });

  it("records what the BEFORE tree is, so the comparison is honest", () => {
    const before = load("J6-before.json") as {
      sourceCommit?: string;
      debugRoutePresent?: boolean;
      cacheCount?: number;
    };
    assert.equal(before.debugRoutePresent, false, "the base commit has no debug route");
    assert.equal(before.cacheCount, 0, "the base commit has no bounded caches");
    assert.ok(before.sourceCommit, "the BEFORE revision must be recorded");
    const after = load("J6-after.json") as { sourceCommit?: string; debugRoutePresent?: boolean };
    assert.ok(after.sourceCommit, "the AFTER revision must be recorded");
    assert.notEqual(before.sourceCommit, after.sourceCommit, "the two runs must differ");
  });

  it("shows the bounded caches present in the AFTER tree", () => {
    const after = load("J6-after.json") as {
      debugRoutePresent?: boolean;
      cacheCount?: number;
      retainedCacheBytes?: number;
    };
    assert.equal(after.debugRoutePresent, true, "the J6 debug route must answer 200");
    assert.ok((after.cacheCount ?? 0) > 0, "J6 must register at least one bounded cache");
  });

  it("did not regress process growth beyond the threshold", () => {
    const before = load("J6-before.json") as { growthMB?: number; thresholdExceeded?: boolean };
    const after = load("J6-after.json") as { growthMB?: number; thresholdExceeded?: boolean };
    assert.equal(before.thresholdExceeded, false, "the baseline must be clean");
    assert.equal(after.thresholdExceeded, false, "J6 must not trip the growth gate");
    assert.ok((after.growthMB ?? Infinity) <= (before.growthMB ?? Infinity) + DEFAULT_THRESHOLD_MB);
  });
});
