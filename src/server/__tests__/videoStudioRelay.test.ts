import assert from "node:assert";
import { describe, it } from "node:test";
import { subscribeTask } from "../streams.js";
import { VideoStudioRelay } from "../videoStudioRelay.js";

interface StreamCommand {
  id: string;
  target: "film" | "effects";
  method: string;
  params: Record<string, unknown>;
}

interface Attachment {
  commands: StreamCommand[];
  unsubscribe: () => void;
}

/** Attach a fake panel to a task's event stream and record relayed commands. */
function attach(taskId: string): Attachment {
  const commands: StreamCommand[] = [];
  const unsubscribe = subscribeTask(taskId, (event) => {
    if (event.type === "video_studio_command") commands.push(event);
  });
  return { commands, unsubscribe };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("videoStudioRelay", () => {
  it("enqueue publishes a command and resolve settles the promise", async () => {
    const relay = new VideoStudioRelay();
    const { commands, unsubscribe } = attach("t1");
    try {
      const promise = relay.enqueue("t1", "film", "inspect", { depth: 2 });
      await waitFor(() => commands.length === 1);
      assert.equal(commands[0]?.method, "inspect");
      assert.equal(commands[0]?.params["depth"], 2);
      assert.equal(relay.resolve({ id: commands[0]!.id, taskId: "t1", ok: true, result: { clips: 4 } }), true);
      assert.deepEqual(await promise, { clips: 4 });
    } finally {
      unsubscribe();
    }
  });

  it("rejects with TIMEOUT when the panel never answers", async () => {
    const relay = new VideoStudioRelay({ timeoutMs: 20 });
    const { unsubscribe } = attach("t1");
    try {
      await assert.rejects(
        relay.enqueue("t1", "film", "execute", { command: "file.newProject" }),
        (err: unknown) => err instanceof Error && (err as { code?: string }).code === "TIMEOUT",
      );
      // A late result for the timed-out id is ignored.
      assert.equal(relay.resolve({ id: "missing", taskId: "t1", ok: true }), false);
    } finally {
      unsubscribe();
    }
  });

  it("rejects with COMMAND_REJECTED when the panel reports a failed command", async () => {
    const relay = new VideoStudioRelay();
    const { commands, unsubscribe } = attach("t1");
    try {
      const promise = relay.enqueue("t1", "film", "execute", { command: "sequence.applyVideoTransition" });
      await waitFor(() => commands.length === 1);
      assert.equal(relay.resolve({ id: commands[0]!.id, taskId: "t1", ok: false, error: "unsupported transition" }), true);
      await assert.rejects(promise, (err: unknown) => (err as { code?: string }).code === "COMMAND_REJECTED");
    } finally {
      unsubscribe();
    }
  });

  it("ignores results for unknown command ids", () => {
    const relay = new VideoStudioRelay();
    assert.equal(relay.resolve({ id: "does-not-exist", taskId: "t1", ok: true, result: 1 }), false);
  });

  it("runs one task's commands in order, one at a time", async () => {
    const relay = new VideoStudioRelay();
    const { commands, unsubscribe } = attach("t1");
    try {
      const p1 = relay.enqueue("t1", "film", "a");
      const p2 = relay.enqueue("t1", "film", "b");
      const p3 = relay.enqueue("t1", "film", "c");

      await waitFor(() => commands.length === 1);
      assert.deepEqual(commands.map((c) => c.method), ["a"]);
      relay.resolve({ id: commands[0]!.id, taskId: "t1", ok: true, result: 1 });

      await waitFor(() => commands.length === 2);
      assert.deepEqual(commands.map((c) => c.method), ["a", "b"]);
      relay.resolve({ id: commands[1]!.id, taskId: "t1", ok: true, result: 2 });

      await waitFor(() => commands.length === 3);
      assert.deepEqual(commands.map((c) => c.method), ["a", "b", "c"]);
      relay.resolve({ id: commands[2]!.id, taskId: "t1", ok: true, result: 3 });

      assert.deepEqual(await Promise.all([p1, p2, p3]), [1, 2, 3]);
    } finally {
      unsubscribe();
    }
  });

  it("rejects with PANEL_NOT_OPEN when no client is subscribed", async () => {
    const relay = new VideoStudioRelay();
    await assert.rejects(
      relay.enqueue("t1", "film", "inspect"),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === "PANEL_NOT_OPEN",
    );
  });

  it("cancels queued and in-flight commands when the task stops", async () => {
    const relay = new VideoStudioRelay({ timeoutMs: 5_000 });
    const { commands, unsubscribe } = attach("t1");
    try {
      const p1 = relay.enqueue("t1", "film", "a");
      const p2 = relay.enqueue("t1", "film", "b");
      await waitFor(() => commands.length === 1);
      relay.cancelTask("t1");
      await assert.rejects(p1, (err: unknown) => (err as { code?: string }).code === "CANCELLED");
      await assert.rejects(p2, (err: unknown) => (err as { code?: string }).code === "CANCELLED");
      assert.equal(relay.pendingCount("t1"), 0);
    } finally {
      unsubscribe();
    }
  });

  it("keeps commands for different tasks independent", async () => {
    const relay = new VideoStudioRelay();
    const a = attach("task-a");
    const b = attach("task-b");
    try {
      const pa = relay.enqueue("task-a", "film", "inspect");
      const pb = relay.enqueue("task-b", "effects", "renderFrame");
      await waitFor(() => a.commands.length === 1 && b.commands.length === 1);
      assert.equal(a.commands[0]?.method, "inspect");
      assert.equal(b.commands[0]?.target, "effects");
      relay.resolve({ id: b.commands[0]!.id, taskId: "task-b", ok: true, result: "frame" });
      assert.equal(await pb, "frame");
      relay.resolve({ id: a.commands[0]!.id, taskId: "task-a", ok: true, result: "state" });
      assert.equal(await pa, "state");
    } finally {
      a.unsubscribe();
      b.unsubscribe();
    }
  });
});
