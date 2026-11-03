/**
 * P4 acceptance: the foreground guard, the key denylist, and `guarded()` —
 * every physical path refuses when the foreground is wrong, and nothing is
 * spawned when it refuses. All probes/legacy are injected; no real input.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ForegroundGuard, deniedKey, guarded, type FgSample } from "../guard.js";

const sample = (hwnd: number, x = 10, y = 10): FgSample => ({ hwnd, pid: 100 + hwnd, x, y });

function makeGuard(opts: { target?: { windowId?: string; hwnd?: number }; probeSeq?: FgSample[]; focused?: string | null }) {
  const seq = opts.probeSeq ?? [];
  let i = 0;
  // Repeat the last sample once the sequence is exhausted (the probe is a
  // standing sampler, not a one-shot tape).
  const probe = async () => seq.length === 0 ? sample(0) : seq[Math.min(i++, seq.length - 1)]!;
  const g = new ForegroundGuard(probe, async () => opts.focused ?? null);
  if (opts.target) g.setTarget(opts.target);
  return { g, probe };
}

describe("ForegroundGuard.check", () => {
  it("refuses when no target window was chosen", async () => {
    const { g } = makeGuard({});
    const refusal = await g.check();
    assert.match(refusal ?? "", /GUARD_BLOCKED: no target window chosen/);
  });

  it("allows when the focused window id matches the target", async () => {
    const { g } = makeGuard({ target: { windowId: "w-1" }, focused: "w-1" });
    assert.equal(await g.check(), null);
  });

  it("refuses when a different window is foreground (hwnd mismatch)", async () => {
    const { g } = makeGuard({ target: { windowId: "w-1", hwnd: 111 }, focused: "w-2", probeSeq: [sample(999)] });
    const refusal = await g.check();
    assert.match(refusal ?? "", /foreground window is not the task window/);
  });

  it("allows on hwnd match even when the id resolver disagrees", async () => {
    const { g } = makeGuard({ target: { hwnd: 111 }, focused: null, probeSeq: [sample(111)] });
    assert.equal(await g.check(), null);
  });

  it("refuses when the probe is unavailable (fail closed)", async () => {
    const g = new ForegroundGuard(async () => null, async () => null);
    g.setTarget({ hwnd: 5 });
    const refusal = await g.check();
    assert.match(refusal ?? "", /GUARD_BLOCKED/);
  });
});

describe("guarded", () => {
  it("blocks the send when the guard refuses — send never runs", async () => {
    let sent = 0;
    const { g } = makeGuard({}); // no target → refusal
    const out = await guarded(g, async () => sample(1), async () => {
      sent += 1;
      return "sent";
    });
    assert.match(out.blocked ?? "", /GUARD_BLOCKED/);
    assert.equal(sent, 0);
  });

  it("sends and reports foregroundChanged / mouseMoved", async () => {
    // Three samples: check() (hwnd 1 = the target), guarded's before (hwnd 2),
    // guarded's after (hwnd 3, cursor moved).
    const { g, probe } = makeGuard({ target: { hwnd: 1 }, probeSeq: [sample(1, 5, 5), sample(2, 5, 5), sample(3, 5, 9)] });
    const out = await guarded(g, probe, async () => "sent");
    assert.equal(out.value, "sent");
    assert.equal(out.foregroundChanged, true); // hwnd 2 → 3
    assert.equal(out.mouseMoved, true); // y 5 → 9
  });

  it("reports no change when the probe samples match", async () => {
    const { g, probe } = makeGuard({ target: { hwnd: 7 }, probeSeq: [sample(7), sample(7)] });
    g.setTarget({ hwnd: 7 });
    const out = await guarded(g, probe, async () => "ok");
    assert.equal(out.foregroundChanged, false);
    assert.equal(out.mouseMoved, false);
  });
});

describe("deniedKey (denylist before the guard)", () => {
  it("refuses the forbidden system combos in both spellings", () => {
    for (const combo of ["alt+f4", "ALT+F4", "%{F4}", "win+r", "win+l", "Win+L", "{LWIN}x", "ctrl+alt+del", "ctrl+alt+delete", "^%{del}", "ctrl+shift+esc", "^+{esc}"]) {
      assert.ok(deniedKey(combo), `${combo} must be denied`);
    }
  });

  it("allows ordinary combos", () => {
    for (const combo of ["ctrl+s", "^s", "{ENTER}", "shift+end", "ctrl+shift+p"]) {
      assert.equal(deniedKey(combo), null, `${combo} must be allowed`);
    }
  });

  it("refuses an empty combo", () => {
    assert.match(deniedKey(" ") ?? "", /empty/);
  });
});
