import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { announceRelayTargets } from "../relayAttach.js";
import { subscribeTask } from "../streams.js";
import { WorkspaceRelay, WorkspaceRelayError } from "../workspaceRelay.js";

describe("workspace relay attach wait", () => {
  it("dispatches once the named target attaches", async () => {
    const relay = new WorkspaceRelay({ attachTimeoutMs: 400 });
    const taskId = "attach-ok";
    const detach = announceRelayTargets(taskId, ["slides"]);
    const stop = subscribeTask(taskId, () => undefined);
    try {
      const pending = relay.enqueue(taskId, "slides", "craft.open", { path: "deck.pptx" });
      const timer = setTimeout(() => relay.cancelTask(taskId), 300);
      relay.cancelTask(taskId);
      clearTimeout(timer);
      await assert.rejects(pending, (err: unknown) => err instanceof WorkspaceRelayError && err.code === "CANCELLED");
    } finally {
      detach();
      stop();
    }
  });

  it("dispatches a command when the target is already attached", async () => {
    const relay = new WorkspaceRelay({ attachTimeoutMs: 200 });
    const taskId = "attach-ready";
    const detach = announceRelayTargets(taskId, ["docs"]);
    try {
      const pending = relay.enqueue(taskId, "docs", "craft.open", {});
      assert.equal(relay.pendingCount(taskId, "docs"), 1);
      relay.cancelTask(taskId);
      await assert.rejects(pending);
    } finally {
      detach();
    }
  });

  it("rejects PANEL_NOT_OPEN when the target never attaches", async () => {
    const relay = new WorkspaceRelay({ attachTimeoutMs: 30 });
    await assert.rejects(
      relay.enqueue("attach-timeout", "slides", "craft.open", {}),
      (err: unknown) => err instanceof WorkspaceRelayError && err.code === "PANEL_NOT_OPEN",
    );
  });

  it("rejects CANCELLED when the task stops during the wait", async () => {
    const relay = new WorkspaceRelay({ attachTimeoutMs: 2_000 });
    const pending = relay.enqueue("attach-cancel", "sheets", "craft.open", {});
    setTimeout(() => relay.cancelTask("attach-cancel"), 20);
    await assert.rejects(pending, (err: unknown) => err instanceof WorkspaceRelayError && err.code === "CANCELLED");
  });

  it("repeats the open request for a listener that connects during the wait", async () => {
    const relay = new WorkspaceRelay({ attachTimeoutMs: 700 });
    const taskId = "attach-late-listen";
    const release = announceRelayTargets(taskId, []);
    const pending = relay.enqueue(taskId, "slides", "craft.open", { path: "museum.pptx" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    let saw = false;
    const stop = subscribeTask(taskId, (event) => {
      if (event.type === "workspace_open_request" && event.target === "slides") saw = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    relay.cancelTask(taskId);
    await assert.rejects(pending, (err: unknown) => err instanceof WorkspaceRelayError && err.code === "CANCELLED");
    stop();
    release();
    assert.equal(saw, true);
  });

  it("delivers the command after the named target attaches late", async () => {
    const relay = new WorkspaceRelay({ attachTimeoutMs: 500, timeoutMs: 2_000 });
    const taskId = "attach-deliver";
    const seen: string[] = [];
    const releaseObserve = announceRelayTargets(taskId, []);
    let releaseSlides = (): void => undefined;
    const stop = subscribeTask(taskId, (event) => {
      seen.push(event.type);
      if (event.type !== "workspace_command") return;
      relay.resolve({ id: event.id, taskId, ok: true, result: { delivered: true } });
    });
    try {
      const pending = relay.enqueue(taskId, "slides", "deck.open", { path: "museum.pptx" });
      setTimeout(() => {
        releaseSlides = announceRelayTargets(taskId, ["slides"]);
      }, 40);
      assert.deepEqual(await pending, { delivered: true });
      assert.ok(seen.includes("workspace_open_request"));
      assert.ok(seen.includes("workspace_command"));
    } finally {
      releaseSlides();
      releaseObserve();
      relay.cancelTask(taskId);
      stop();
    }
  });

  it("does not treat a different target as attached", async () => {
    const relay = new WorkspaceRelay({ attachTimeoutMs: 40 });
    const taskId = "attach-other";
    const detach = announceRelayTargets(taskId, ["docs"]);
    try {
      await assert.rejects(
        relay.enqueue(taskId, "slides", "craft.open", {}),
        (err: unknown) => err instanceof WorkspaceRelayError && err.code === "PANEL_NOT_OPEN",
      );
    } finally {
      detach();
    }
  });
});
