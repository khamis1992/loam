/**
 * Tests for the shared bounded fan-out primitive used by map_reduce and the
 * workflow runner. No model or network is involved.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runBounded } from "../mapReduce.js";

describe("runBounded", () => {
  it("returns one result per item", async () => {
    const results = await runBounded([1, 2, 3, 4], 2, async (n) => n * 2);
    assert.deepEqual(results.sort((a, b) => a - b), [2, 4, 6, 8]);
  });

  it("never runs more workers than the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await runBounded(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async (n) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        return n;
      },
    );
    assert.ok(peak <= 3, `peak concurrency ${peak} must stay within the limit`);
  });

  it("drops null results (a skipped item contributes nothing)", async () => {
    const results = await runBounded([1, 2, 3], 1, async (n) => (n === 2 ? null : n));
    assert.deepEqual(results, [1, 3]);
  });

  it("stops starting new work after the signal aborts", async () => {
    const controller = new AbortController();
    const seen: number[] = [];
    const results = await runBounded([1, 2, 3, 4], 1, async (n) => {
      seen.push(n);
      if (n === 2) controller.abort();
      return n;
    }, controller.signal);
    assert.deepEqual(seen, [1, 2], "no item starts after abort");
    assert.deepEqual(results, [1, 2]);
  });

  it("handles an empty item list", async () => {
    assert.deepEqual(await runBounded([], 4, async (n: number) => n), []);
  });
});
