import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { announceRelayTargets } from "../relayAttach.js";
import { VideoStudioRelay, VideoStudioRelayError } from "../videoStudioRelay.js";

describe("video studio relay attach wait", () => {
  it("dispatches when film is already attached", async () => {
    const relay = new VideoStudioRelay({ attachTimeoutMs: 200 });
    const taskId = "film-ready";
    const detach = announceRelayTargets(taskId, ["film"]);
    try {
      const pending = relay.enqueue(taskId, "film", "inspect", {});
      assert.equal(relay.pendingCount(taskId, "film"), 1);
      relay.cancelTask(taskId);
      await assert.rejects(pending);
    } finally {
      detach();
    }
  });

  it("rejects PANEL_NOT_OPEN when film never attaches", async () => {
    const relay = new VideoStudioRelay({ attachTimeoutMs: 30 });
    await assert.rejects(
      relay.enqueue("film-timeout", "film", "inspect", {}),
      (err: unknown) => err instanceof VideoStudioRelayError && err.code === "PANEL_NOT_OPEN",
    );
  });

  it("rejects CANCELLED when the task stops during the wait", async () => {
    const relay = new VideoStudioRelay({ attachTimeoutMs: 2_000 });
    const pending = relay.enqueue("film-cancel", "effects", "inspect", {});
    setTimeout(() => relay.cancelTask("film-cancel"), 20);
    await assert.rejects(pending, (err: unknown) => err instanceof VideoStudioRelayError && err.code === "CANCELLED");
  });

  it("does not treat film as attached to effects", async () => {
    const relay = new VideoStudioRelay({ attachTimeoutMs: 40 });
    const detach = announceRelayTargets("film-other", ["film"]);
    try {
      await assert.rejects(
        relay.enqueue("film-other", "effects", "inspect", {}),
        (err: unknown) => err instanceof VideoStudioRelayError && err.code === "PANEL_NOT_OPEN",
      );
    } finally {
      detach();
    }
  });
});
