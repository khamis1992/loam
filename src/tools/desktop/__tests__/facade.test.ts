/**
 * P4 acceptance: the facade — backend selection, the §2.5 fallback table
 * (no second call after delivered_* / unknown), the guarded physical paths on
 * BOTH backends, untrusted marking, the tool-name/param schema snapshot, and
 * that no window title ever reaches a log line. Everything is injected: a fake
 * agent-desktop backend, a fake legacy pair, a fake guard probe.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computerUseTools, makeComputerUseToolsForTest as makeComputerUseTools } from "../../computerUse.js";
import type { ActResult, DesktopBackend, DesktopTarget, ObserveOpts } from "../backend.js";
import type { AdSnapshot } from "../adTypes.js";
import type { LegacyDeps } from "../legacyBackend.js";
import { ForegroundGuard, type FgSample } from "../guard.js";

/* ------------------------------- doubles -------------------------------- */

/** Module-scope fake backend factory: every call is recorded; results come from
 *  the injected adResult(command) so tests can pin dispositions per case. */
function makeFakeBackend(calls: Calls, adResult: (command: string) => ActResult): DesktopBackend {
  return {
    id: "agent-desktop",
    async available() {
      return { ok: true, version: "fake" };
    },
    async listWindows() {
      calls.ad.push("list-windows");
      return { ...adResult("list-windows"), raw: { windows: [{ id: "w-1", app_name: "Fake.exe", title: "fake window title", is_focused: true }] } };
    },
    async snapshot(o: ObserveOpts) {
      calls.ad.push("snapshot");
      const tree: AdSnapshot = {
        app: "Fake.exe",
        window: { id: o.windowId ?? "w-1", title: "fake window title" },
        snapshot_id: "s1",
        ref_count: 1,
        complete: true,
        tree: { role: "window", name: "Fake", children: [{ role: "button", name: "OK", ref_id: "@s1:e1" }] },
      };
      return { ...adResult("snapshot"), snapshot: tree };
    },
    async find(t: DesktopTarget & { role?: string; name?: string }) {
      void t;
      calls.ad.push("find");
      return { ...adResult("find"), raw: { results: [{ role: "button", name: "OK", ref_id: "@s1:e1" }] } };
    },
    async act(ref: string, action: string) {
      calls.ad.push(`act:${action}:${ref}`);
      return adResult(action);
    },
    async typeHeaded(ref: string) {
      calls.ad.push(`type:${ref}`);
      return adResult("type");
    },
    async press(combo: string) {
      calls.ad.push(`press:${combo}`);
      return adResult("press");
    },
    async focusWindow(id: string) {
      calls.ad.push(`focus-window:${id}`);
      return adResult("focus-window");
    },
    async screenshot(t: DesktopTarget & { out: string }) {
      calls.ad.push(`screenshot:${t.out.slice(-8)}`);
      return adResult("screenshot");
    },
  };
}

interface Calls {
  ad: string[];
  legacyPs: string[];
  clicks: Array<{ x: number; y: number }>;
  guardChecks: number;
  probeSamples: number;
}

function makeWorld(opts: {
  adOk?: boolean;
  binaryVerified?: boolean;
  platform?: string;
  focusedWindowId?: string | null;
  probeHwnds?: number[];
  cfg?: Record<string, unknown>;
}) {
  const calls: Calls = { ad: [], legacyPs: [], clicks: [], guardChecks: 0, probeSamples: 0 };
  const sampleSeq = (opts.probeHwnds ?? [1]).map((h) => ({ hwnd: h, pid: 1, x: 0, y: 0 } as FgSample));
  let probeI = 0;
  const probe = async (): Promise<FgSample | null> => {
    calls.probeSamples += 1;
    return sampleSeq[Math.min(probeI++, sampleSeq.length - 1)] ?? null;
  };
  const focused = async () => opts.focusedWindowId ?? null;
  const guard = new ForegroundGuard(probe, focused);
  const origCheck = guard.check.bind(guard);
  (guard as unknown as { check: () => Promise<string | null> }).check = async () => {
    calls.guardChecks += 1;
    return origCheck();
  };

  const adResult = (command: string): ActResult =>
    opts.adOk === false
      ? { ok: false, backend: "agent-desktop", delivery: "delivered_unverified", retry: "unsafe", code: "ACTION_FAILED", message: command }
      : { ok: true, backend: "agent-desktop", delivery: "delivered_verified", retry: "unsafe", message: command };

  const backend: DesktopBackend = makeFakeBackend(calls, adResult);

  const legacy: LegacyDeps = {
    async runPs(script, args) {
      calls.legacyPs.push(`${script.split("\\").pop()?.split("/").pop()}:${args.join(" ")}`);
      return { code: 0, out: '{"found":true,"x":10,"y":10,"w":20,"h":20,"name":"fake window title","role":"Button"}', err: "" };
    },
    async clickPoint(x, y) {
      calls.clicks.push({ x, y });
      return `clicked left at ${x},${y}`;
    },
  };

  const savedPlatform = process.platform;
  if (opts.platform) Object.defineProperty(process, "platform", { value: opts.platform, configurable: true });

  // The facade builds its guard lazily through makeGuard; capture that instance
  // so tests can set its target (the instrumented guard above is only a shell).
  let facadeGuard: ForegroundGuard | null = null;
  const tools = makeComputerUseTools({
    legacy,
    makeGuard: (focusedFn: () => Promise<string | null>) => {
      facadeGuard = new ForegroundGuard(probe, focusedFn);
      return facadeGuard;
    },
    verifyBinary: () => ({ ok: opts.binaryVerified !== false }),
    exePath: () => "C:/fake/ad.exe",
    makeBackend: (() => backend) as never,
  });

  const ctx = {
    cfg: {
      computerUse: {
        enabled: true,
        screenshotDir: "C:/tmp/shots",
        backend: "auto",
        allowHeaded: true,
        agentDesktop: { stateRoot: "", snapshotTimeoutMs: 3000, maxRenderedLines: 400, trace: false, pruneOldSnapshots: true, postActionDelta: true, maxDeltaLines: 40 },
      },
      ...(opts.cfg ?? {}),
    },
    workspace: "C:/tmp/w",
  } as never;

  type ToolLike = { run(args: Record<string, unknown>, ctx: unknown): Promise<{ ok: boolean; content: string; untrusted?: boolean }> };
  return {
    tools: Object.fromEntries(tools.map((t: { name: string }) => [t.name, t])) as unknown as Record<string, ToolLike>,
    calls,
    guard: {
      setTarget(t: { windowId?: string; hwnd?: number; app?: string }) {
        facadeGuard?.setTarget(t);
      },
      getTarget() {
        return facadeGuard?.getTarget() ?? null;
      },
    },
    ctx,
    restore() {
      if (opts.platform) Object.defineProperty(process, "platform", { value: savedPlatform, configurable: true });
    },
  };
}

/* -------------------------------- tests --------------------------------- */

describe("backend selection (§2.5 row 1)", () => {
  it("verified binary on win32 → agent-desktop", async () => {
    const w = makeWorld({});
    await w.tools["computer_list_windows"]!.run({}, w.ctx);
    assert.ok(w.calls.ad.includes("list-windows"));
    assert.equal(w.calls.legacyPs.length, 0);
    w.restore();
  });

  it("binary missing → legacy for the whole run, no agent-desktop calls", async () => {
    const w = makeWorld({ binaryVerified: false });
    await w.tools["computer_list_windows"]!.run({}, w.ctx);
    assert.ok(w.calls.legacyPs.length > 0);
    assert.equal(w.calls.ad.length, 0);
    w.restore();
  });

  it("non-win32 → legacy", async () => {
    const w = makeWorld({ platform: "linux" });
    await w.tools["computer_list_windows"]!.run({}, w.ctx);
    assert.equal(w.calls.ad.length, 0);
    w.restore();
  });

  it("config backend:legacy → legacy even with a verified binary", async () => {
    const w = makeWorld({ cfg: { computerUse: { enabled: true, screenshotDir: "C:/s", backend: "legacy" } } });
    await w.tools["computer_list_windows"]!.run({}, w.ctx);
    assert.equal(w.calls.ad.length, 0);
    w.restore();
  });
});

describe("guarded physical paths (both backends)", () => {
  it("legacy computer_click is refused when no target was chosen — no click sent", async () => {
    const w = makeWorld({ binaryVerified: false });
    const r = await w.tools["computer_click"]!.run({ x: 5, y: 5 }, w.ctx);
    assert.equal(r.ok, false);
    assert.match(r.content, /GUARD_BLOCKED/);
    assert.equal(w.calls.clicks.length, 0);
    w.restore();
  });

  it("legacy computer_click is refused when the foreground hwnd differs", async () => {
    const w = makeWorld({ binaryVerified: false, probeHwnds: [42, 42, 42] });
    w.guard.setTarget({ hwnd: 7 });
    const r = await w.tools["computer_click"]!.run({ x: 5, y: 5 }, w.ctx);
    assert.match(r.content, /GUARD_BLOCKED/);
    assert.equal(w.calls.clicks.length, 0);
    w.restore();
  });

  it("legacy computer_key is refused by the guard (and the denylist fires first)", async () => {
    const w = makeWorld({ binaryVerified: false });
    const denied = await w.tools["computer_key"]!.run({ keys: "ctrl+s" }, w.ctx);
    assert.match(denied.content, /GUARD_BLOCKED/); // no target
    assert.equal(w.calls.legacyPs.filter((c) => c.startsWith("input.ps1")).length, 0);
    const forbidden = await w.tools["computer_key"]!.run({ keys: "alt+f4" }, w.ctx);
    assert.match(forbidden.content, /denied/);
    w.restore();
  });

  it("agent-desktop computer_type(ref) is refused by the guard — nothing typed", async () => {
    const w = makeWorld({});
    const r = await w.tools["computer_type"]!.run({ text: "hi", ref: "@s1:e1" }, w.ctx);
    assert.match(r.content, /GUARD_BLOCKED/);
    assert.equal(w.calls.ad.filter((c) => c.startsWith("type:")).length, 0);
    w.restore();
  });

  it("guard passes when the target hwnd IS the foreground — the click goes out (legacy)", async () => {
    const w = makeWorld({ binaryVerified: false, probeHwnds: [7, 7, 7] });
    w.guard.setTarget({ hwnd: 7 });
    const r = await w.tools["computer_click"]!.run({ x: 5, y: 5 }, w.ctx);
    assert.equal(r.ok, true);
    assert.equal(w.calls.clicks.length, 1);
    w.restore();
  });
});

describe("fallback table (§2.5)", () => {
  it("after delivered_* there is NO second call — the result stands", async () => {
    const w = makeWorld({ adOk: false }); // every ad act fails as delivered_unverified/unsafe
    const before = w.calls.ad.length + w.calls.legacyPs.length;
    const r = await w.tools["computer_ui_click"]!.run({ ref: "@s1:e1" }, w.ctx);
    assert.equal(r.ok, false);
    assert.match(r.content, /delivered_unverified/);
    const adActs = w.calls.ad.filter((c) => c.startsWith("act:")).length;
    const legacyAfter = w.calls.legacyPs.length;
    assert.equal(adActs, 1, "exactly one act call, no retry/fallback");
    assert.equal(legacyAfter, before === 0 ? 0 : legacyAfter, "legacy never invoked for a delivered_* failure");
    w.restore();
  });

  it("ELEMENT_NOT_FOUND tells the model to re-snapshot; never legacy", async () => {
    const w = makeWorld({});
    const notFound: DesktopBackend = {
      ...makeFakeBackend(w.calls, (command) => ({ ok: true, backend: "agent-desktop", delivery: "delivered_verified", retry: "unsafe", message: command })),
      async act(ref: string) {
        w.calls.ad.push(`act:click:${ref}`);
        return { ok: false, backend: "agent-desktop", delivery: "not_delivered", retry: "safe", code: "ELEMENT_NOT_FOUND", message: "no such element", needsFreshSnapshot: true };
      },
    };
    const tools = makeComputerUseTools({
      legacy: { async runPs() { w.calls.legacyPs.push("ps"); return { code: 0, out: "{}", err: "" }; }, async clickPoint() { w.calls.clicks.push({ x: 0, y: 0 }); return "clicked"; } },
      makeGuard: (f: () => Promise<string | null>) => new ForegroundGuard(async () => ({ hwnd: 1, pid: 1, x: 0, y: 0 }), f),
      verifyBinary: () => ({ ok: true }),
      exePath: () => "C:/fake/ad.exe",
      makeBackend: (() => notFound) as never,
    });
    const map = Object.fromEntries(tools.map((t: { name: string }) => [t.name, t])) as unknown as Record<string, { run(a: Record<string, unknown>, c: unknown): Promise<{ ok: boolean; content: string }> }>;
    const r = await map["computer_act"]!.run({ ref: "@s1:e1", action: "click" }, w.ctx);
    assert.equal(r.ok, false);
    assert.match(r.content, /ELEMENT_NOT_FOUND/);
    assert.match(r.content, /retry=safe/);
    assert.equal(w.calls.legacyPs.length, 0, "ELEMENT_NOT_FOUND never falls back to legacy");
    w.restore();
  });

  it("computer_snapshot/find/act/batch on legacy answer with guidance, not legacy calls", async () => {
    const w = makeWorld({ binaryVerified: false });
    for (const [name, args] of [["computer_snapshot", { window_id: "w-1" }], ["computer_find", { window_id: "w-1" }], ["computer_act", { ref: "@s1:e1", action: "click" }]] as const) {
      const r = await w.tools[name]!.run(args as Record<string, unknown>, w.ctx);
      assert.equal(r.ok, false, `${name} must fail on legacy`);
      assert.match(r.content, /agent-desktop backend/);
    }
    assert.equal(w.calls.legacyPs.length, 0);
    w.restore();
  });
});

describe("surface contracts", () => {
  it("every result is untrusted data", async () => {
    const w = makeWorld({});
    const r = await w.tools["computer_list_windows"]!.run({}, w.ctx);
    assert.equal(r.untrusted, true);
    const s = await w.tools["computer_snapshot"]!.run({ window_id: "w-1" }, w.ctx);
    assert.equal(s.untrusted, true);
    w.restore();
  });

  it("the window title never appears in tool output logs — ids and exe names only", async () => {
    const w = makeWorld({});
    const r = await w.tools["computer_list_windows"]!.run({}, w.ctx);
    assert.doesNotMatch(r.content, /fake window title/, "list_windows must render id + exe, not the title");
    assert.match(r.content, /w-1 Fake\.exe/);
    w.restore();
  });

  it("old tool names and parameters still exist (schema snapshot)", () => {
    const w = makeWorld({});
    const expected: Record<string, string[]> = {
      computer_screenshot: ["name"],
      computer_list_windows: [],
      computer_focus_window: ["title", "window_id"],
      computer_ui_tree: ["depth", "window_id"],
      computer_ui_list: ["name", "role", "max"],
      computer_ui_click: ["ref", "index", "name", "role"],
      computer_ui_set_text: ["text", "ref", "index", "name", "role"],
      computer_click: ["x", "y", "right"],
      computer_type: ["text", "ref"],
      computer_key: ["keys"],
      computer_snapshot: ["window_id", "skeleton", "root", "max_depth"],
      computer_find: ["window_id", "role", "name", "exact", "limit"],
      computer_act: ["ref", "action", "value"],
      computer_batch: ["steps"],
    };
    for (const [name, props] of Object.entries(expected)) {
      const tool = w.tools[name];
      assert.ok(tool, `${name} must exist`);
      const schema = tool as unknown as { parameters?: { properties?: Record<string, unknown> } };
      const got = Object.keys(schema.parameters?.properties ?? {});
      for (const p of props) assert.ok(got.includes(p), `${name}.${p} must exist`);
    }
    w.restore();
  });

  it("descriptions stay within 300 characters", () => {
    const w = makeWorld({});
    void w;
    for (const t of computerUseTools) {
      assert.ok(t.description.length <= 300, `${t.name} description ${t.description.length} > 300`);
    }
    w.restore();
  });
});
