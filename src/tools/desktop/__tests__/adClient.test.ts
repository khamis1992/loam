/**
 * P3 acceptance: runAd (spawn/parse/timeout/abort/argv safety) and the
 * agent-desktop backend result mapping, all against the fake CLI running as a
 * real Node child process via process.execPath — no .cmd shim, no shell, ever.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { runAd, buildAdArgv, type SpawnFn } from "../adClient.js";
import { agentDesktopBackend } from "../agentDesktopBackend.js";
import { AD_ERROR_CODES } from "../adTypes.js";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures", "fake-agent-desktop.mjs");
const EXE = process.execPath;
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-adc-"));

/** Spawn wrapper that routes every call through the fixture script (node can
 *  only run a .mjs as its script, so the fixture path is injected as argv[0])
 *  and pins FAKE_AD_MODE onto the child's minimal env. */
function modeSpawn(mode: string): SpawnFn {
  return (exe, args, opts) => spawn(exe, [FIXTURE, ...args], { ...opts, env: { ...opts.env, FAKE_AD_MODE: mode } });
}

/** Same routing as modeSpawn, but counts every spawn for the no-spawn assertions. */
function countingSpawn(tick: () => void): SpawnFn {
  return (exe, args, opts) => {
    tick();
    return spawn(exe, [FIXTURE, ...args], opts);
  };
}

after(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

describe("runAd envelope handling", () => {
  it("parses an ok envelope", async () => {
    const c = await runAd<unknown>(EXE, ["version"], { stateRoot }, modeSpawn("ok-version"));
    assert.equal(c.exitCode, 0);
    assert.ok(c.env?.ok === true);
  });

  it("maps every structured error code to a correct disposition", async () => {
    for (const code of AD_ERROR_CODES) {
      const c = await runAd<unknown>(EXE, ["op", "@s1:e1"], { stateRoot }, modeSpawn(`err:${code}`));
      assert.ok(c.env && c.env.ok === false, `${code} must produce an envelope`);
      const e = (c.env as { error: { code: string; disposition: { delivery: string; retry: string } } }).error;
      assert.equal(e.code, code);
      if (e.disposition.retry === "safe") assert.equal(e.disposition.delivery, "not_delivered", `${code}: retry=safe implies not_delivered`);
    }
  });

  it("exit-2 parse error still prints an INVALID_ARGS envelope", async () => {
    const c = await runAd<unknown>(EXE, ["get", "@s1:e1"], { stateRoot }, modeSpawn("exit2-parse-error"));
    assert.equal(c.exitCode, 2);
    assert.equal((c.env as { error: { code: string } } | null)?.error.code, "INVALID_ARGS");
  });

  it("garbage stdout → no envelope", async () => {
    const c = await runAd<unknown>(EXE, ["version"], { stateRoot }, modeSpawn("garbage"));
    assert.equal(c.env, null);
    assert.ok(c.stdoutBytes > 0);
  });

  it("timeout kills only the child (the test process stays alive)", async () => {
    const t0 = Date.now();
    const c = await runAd<unknown>(EXE, ["version"], { stateRoot, timeoutMs: 300 }, modeSpawn("sleep"));
    assert.equal(c.timedOut, true);
    assert.ok(Date.now() - t0 < 5_000, "the sleeping child must be killed at the timeout, not waited out");
    assert.equal(c.env, null);
  });

  it("abort kills the child", async () => {
    const ac = new AbortController();
    const p = runAd<unknown>(EXE, ["version"], { stateRoot, timeoutMs: 60_000, signal: ac.signal }, modeSpawn("sleep"));
    setTimeout(() => ac.abort(), 200);
    const c = await p;
    assert.equal(c.timedOut, false);
    assert.equal(c.env, null);
  });

  it("argv with quotes, &, |, %PATH%, newline and Arabic arrives as ONE element each", async () => {
    const nasty = ['he said "hi"', "a&b", "x|y", "%PATH%", "line1\nline2", "اكتب نصاً عربياً"];
    const c = await runAd<unknown>(EXE, ["set-value", "@s1:e2", ...nasty], { stateRoot }, modeSpawn("echo"));
    const argv = (c.env as { data: { argv: string[] } }).data.argv;
    // The fixture reports process.argv.slice(2): ["set-value", "@s1:e2", ...nasty]
    assert.deepEqual(argv.slice(2), nasty);
  });

  it("--force can never be emitted (throws before spawn)", async () => {
    await assert.rejects(
      async () => {
        runAd<unknown>(EXE, ["press", "alt+f4", "--force"], { stateRoot }, modeSpawn("echo"));
      },
      /--force is forbidden/,
    );
  });

  it("headed and session flags are prepended in order (pure buildAdArgv)", () => {
    assert.deepEqual(buildAdArgv(["version"], { headed: true, session: "loam-t" }), ["--headed", "--session", "loam-t", "version"]);
    assert.deepEqual(buildAdArgv(["version"], {}), ["version"]);
    assert.deepEqual(buildAdArgv(["version"], { session: "s" }), ["--session", "s", "version"]);
    assert.equal(buildAdArgv(["press", "x", "--force"], {}).includes("--force"), true, "runAd rejects it; build stays pure");
  });
});

describe("agentDesktopBackend mapping", () => {
  it("all 16 error codes surface code/delivery/retry (+ needsFreshSnapshot on STALE_REF)", async () => {
    for (const code of AD_ERROR_CODES) {
      const b = agentDesktopBackend(EXE, stateRoot, "loam-t", undefined, modeSpawn(`err:${code}`));
      const r = await b.act("@s1:e1", "click");
      assert.equal(r.ok, false);
      assert.equal(r.backend, "agent-desktop");
      assert.equal(r.code, code);
      if (code === "STALE_REF") assert.equal(r.needsFreshSnapshot, true);
      if (r.retry === "safe") assert.equal(r.delivery, "not_delivered");
    }
  });

  it("a success without disposition is delivered_unverified / unsafe", async () => {
    const b = agentDesktopBackend(EXE, stateRoot, "loam-t", undefined, modeSpawn("ok-no-disposition"));
    const r = await b.act("@s1:e1", "click");
    assert.equal(r.ok, true);
    assert.equal(r.delivery, "delivered_unverified");
    assert.equal(r.retry, "unsafe");
  });

  it("a snapshot returns the parsed AdSnapshot", async () => {
    const b = agentDesktopBackend(EXE, stateRoot, "loam-t", undefined, modeSpawn("ok-snapshot"));
    const r = await b.snapshot({ windowId: "w-1" });
    assert.equal(r.ok, true);
    assert.equal(r.snapshot?.snapshot_id, "s1");
    assert.equal(r.snapshot.tree.children?.length, 2);
  });

  it("available() reports the version", async () => {
    const b = agentDesktopBackend(EXE, stateRoot, "loam-t", undefined, modeSpawn("ok-version"));
    const v = await b.available();
    assert.deepEqual(v, { ok: true, version: "1.0.2-fake" });
  });

  it("ref validation rejects bare and malformed refs before any spawn", async () => {
    let spawns = 0;
    const b = agentDesktopBackend(EXE, stateRoot, "loam-t", undefined, countingSpawn(() => { spawns += 1; }));
    for (const bad of ["@e7", "abc:e7", "@abc:7", ""]) {
      const r = await b.act(bad, "click");
      assert.equal(r.ok, false);
      assert.equal(r.code, "INVALID_ARGS");
      assert.equal(r.delivery, "not_delivered");
    }
    const root = await b.snapshot({ root: "@e1" });
    assert.equal(root.code, "INVALID_ARGS");
    assert.equal(spawns, 0, "invalid refs must never spawn the CLI");
  });
});
