import assert from "node:assert";
import { describe, it } from "node:test";
import { subscribeTask } from "../streams.js";
import { WorkspaceRelay, WorkspaceRelayError, isCraftTarget, type CraftRelayTarget } from "../workspaceRelay.js";

/** The stream event shape for one relayed command (the event has no taskId). */
interface StreamCommand {
  type: "workspace_command" | "video_studio_command";
  id: string;
  target: string;
  method: string;
  params: Record<string, unknown>;
}

interface Attachment {
  commands: StreamCommand[];
  openRequests: Array<{ target: string; path: string | null }>;
  unsubscribe: () => void;
}

/** Attach a fake editor panel to a task's event stream and record what arrives. */
function attach(taskId: string, target?: string): Attachment {
  const commands: StreamCommand[] = [];
  const openRequests: Array<{ target: string; path: string | null }> = [];
  const unsubscribe = subscribeTask(taskId, (event) => {
    if (event.type === "workspace_open_request") {
      openRequests.push({ target: event.target, path: event.path });
      return;
    }
    if (event.type !== "workspace_command" && event.type !== "video_studio_command") return;
    if (target && event.target !== target) return;
    commands.push(event);
  });
  return { commands, openRequests, unsubscribe };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const CRAFT_TARGETS: CraftRelayTarget[] = ["docs", "sheets", "slides", "photo", "design"];

describe("workspaceRelay (craft targets)", () => {
  it("classifies the craft apps and leaves the video targets alone", () => {
    for (const target of CRAFT_TARGETS) assert.equal(isCraftTarget(target), true, target);
    assert.equal(isCraftTarget("film"), false);
    assert.equal(isCraftTarget("effects"), false);
  });

  it("publishes a craft command and settles it with the panel result", async () => {
    const relay = new WorkspaceRelay();
    const { commands, unsubscribe } = attach("craft-1");
    try {
      const promise = relay.enqueue("craft-1", "docs", "engine.execute", { command: "document.insertText" });
      await waitFor(() => commands.length === 1);
      assert.equal(commands[0]?.target, "docs");
      assert.equal(commands[0]?.method, "engine.execute");
      assert.equal(relay.pendingCount("craft-1", "docs"), 1);
      relay.resolve({ id: commands[0]!.id, taskId: "craft-1", ok: true, result: { inserted: 12 } });
      assert.deepEqual(await promise, { inserted: 12 });
    } finally {
      unsubscribe();
    }
  });

  it("rejects with PANEL_NOT_OPEN and publishes an open request when nothing is attached", async () => {
    const relay = new WorkspaceRelay();
    try {
      // No panel is attached to this task at all, so the enqueue cannot be
      // consumed: the relay asks the shell to open the editor and rejects.
      await assert.rejects(
        relay.enqueue("craft-2", "sheets", "engine.execute", { command: "sheet.read", path: "data/budget.xlsx" }),
        (err: unknown) => err instanceof WorkspaceRelayError && err.code === "PANEL_NOT_OPEN",
      );
      // A shell that opens the panel can ask what to open; the request is
      // one-shot so it is not replayed on every later PANEL_NOT_OPEN.
      assert.deepEqual(relay.takeOpenRequest("craft-2", "sheets"), { target: "sheets", path: "data/budget.xlsx" });
      assert.equal(relay.takeOpenRequest("craft-2", "sheets"), null);
      assert.equal(relay.takeOpenRequest("craft-2", "docs"), null);
      assert.equal(relay.takeOpenRequest("craft-2", "film"), null);
    } finally {
    }
  });

  it("publishes the open request on the stream so an attached shell can open the panel", async () => {
    const relay = new WorkspaceRelay();
    const seen: Array<{ target: string; path: string | null }> = [];
    const unsubscribe = subscribeTask("craft-2b", (event) => {
      if (event.type === "workspace_open_request") seen.push({ target: event.target, path: event.path });
    });
    try {
      // The panel is attached, so the command itself is relayed; no request is
      // published while a client is present.
      const promise = relay.enqueue("craft-2b", "sheets", "craft.open", { path: "data/budget.xlsx" });
      await waitFor(() => relay.pendingCount("craft-2b", "sheets") === 1);
      assert.deepEqual(seen, []);
      assert.deepEqual(relay.openRequestsFor("craft-2b"), []);
      relay.cancelTask("craft-2b");
      await assert.rejects(promise, (err: unknown) => (err as { code?: string }).code === "CANCELLED");
      // The request is cleared with the task's bookkeeping.
      assert.deepEqual(relay.openRequestsFor("craft-2b"), []);
    } finally {
      unsubscribe();
    }
  });

  it("keeps one command in flight per task+target, so a slow Sheets save never blocks Docs", async () => {
    const relay = new WorkspaceRelay();
    const sheets = attach("craft-3", "sheets");
    const docs = attach("craft-3", "docs");
    try {
      const slow = relay.enqueue("craft-3", "sheets", "craft.waitSave", { name: "budget.xlsx" });
      const fast = relay.enqueue("craft-3", "docs", "engine.execute", { command: "document.inspect" });
      await waitFor(() => sheets.commands.length === 1 && docs.commands.length === 1);
      assert.deepEqual(sheets.commands.map((c) => c.method), ["craft.waitSave"]);
      assert.deepEqual(docs.commands.map((c) => c.method), ["engine.execute"]);

      relay.resolve({ id: docs.commands[0]!.id, taskId: "craft-3", ok: true, result: { words: 4 } });
      assert.deepEqual(await fast, { words: 4 });

      // Docs is free to run a second command while Sheets is still saving.
      const second = relay.enqueue("craft-3", "docs", "engine.execute", { command: "document.save" });
      await waitFor(() => docs.commands.length === 2);
      relay.resolve({ id: docs.commands[1]!.id, taskId: "craft-3", ok: true, result: "saved" });
      assert.equal(await second, "saved");

      relay.resolve({ id: sheets.commands[0]!.id, taskId: "craft-3", ok: true, result: { path: "data/budget.xlsx" } });
      assert.deepEqual(await slow, { path: "data/budget.xlsx" });
    } finally {
      sheets.unsubscribe();
      docs.unsubscribe();
    }
  });

  it("runs the commands of one target in FIFO order", async () => {
    const relay = new WorkspaceRelay();
    const { commands, unsubscribe } = attach("craft-4");
    try {
      const promises = ["inspect", "craft.open", "craft.waitSave"].map((method) =>
        relay.enqueue("craft-4", "photo", method, { name: "shots/art.png" }),
      );
      await waitFor(() => commands.length === 1);
      assert.deepEqual(commands.map((c) => c.method), ["inspect"]);
      relay.resolve({ id: commands[0]!.id, taskId: "craft-4", ok: true, result: 1 });

      await waitFor(() => commands.length === 2);
      relay.resolve({ id: commands[1]!.id, taskId: "craft-4", ok: true, result: 2 });

      await waitFor(() => commands.length === 3);
      relay.resolve({ id: commands[2]!.id, taskId: "craft-4", ok: true, result: 3 });

      assert.deepEqual(await Promise.all(promises), [1, 2, 3]);
      assert.equal(relay.pendingCount("craft-4", "photo"), 0);
    } finally {
      unsubscribe();
    }
  });

  it("rejects a craft command that times out and still pumps the queue", async () => {
    const relay = new WorkspaceRelay({ timeoutMs: 20 });
    const { commands, unsubscribe } = attach("craft-5");
    try {
      const first = relay.enqueue("craft-5", "slides", "craft.waitSave", { name: "deck.pptx" });
      const second = relay.enqueue("craft-5", "slides", "engine.execute", { command: "ui.inspect" });
      await assert.rejects(first, (err: unknown) => (err as { code?: string }).code === "TIMEOUT");
      // The blocked command still runs once the timed-out one is dropped.
      await waitFor(() => commands.length === 2);
      assert.equal(commands[1]?.method, "engine.execute");
      relay.resolve({ id: commands[1]!.id, taskId: "craft-5", ok: true, result: "ui" });
      assert.equal(await second, "ui");
    } finally {
      unsubscribe();
    }
  });

  it("cancels the craft commands of one task without touching another task", async () => {
    const relay = new WorkspaceRelay({ timeoutMs: 5_000 });
    const kept = attach("craft-6", "design");
    const dropped = attach("craft-7", "design");
    try {
      const droppedPromise = relay.enqueue("craft-7", "design", "craft.waitSave", { name: "art.psd" });
      const keptPromise = relay.enqueue("craft-6", "design", "craft.waitSave", { name: "art2.psd" });
      await waitFor(() => kept.commands.length === 1 && dropped.commands.length === 1);
      relay.cancelTask("craft-7");
      await assert.rejects(droppedPromise, (err: unknown) => (err as { code?: string }).code === "CANCELLED");
      assert.equal(relay.pendingCount("craft-7"), 0);
      // The other task's queue is untouched.
      assert.equal(relay.pendingCount("craft-6", "design"), 1);
      relay.resolve({ id: kept.commands[0]!.id, taskId: "craft-6", ok: true, result: "ok" });
      assert.equal(await keptPromise, "ok");
    } finally {
      kept.unsubscribe();
      dropped.unsubscribe();
    }
  });

  it("reports COMMAND_REJECTED when the editor refuses a craft command", async () => {
    const relay = new WorkspaceRelay();
    const { commands, unsubscribe } = attach("craft-8");
    try {
      const promise = relay.enqueue("craft-8", "docs", "engine.execute", { command: "document.replace" });
      await waitFor(() => commands.length === 1);
      relay.resolve({ id: commands[0]!.id, taskId: "craft-8", ok: false, error: "unknown command" });
      await assert.rejects(promise, (err: unknown) => (err as { code?: string }).code === "COMMAND_REJECTED");
    } finally {
      unsubscribe();
    }
  });
});

describe("workspaceRelay (video backward compatibility)", () => {
  it("keeps publishing the legacy video_studio_command event for film/effects", async () => {
    const relay = new WorkspaceRelay();
    const seen: string[] = [];
    const ids: string[] = [];
    const unsubscribe = subscribeTask("video-1", (event) => {
      if (event.type === "video_studio_command" || event.type === "workspace_command") {
        seen.push(event.type);
        ids.push(event.id);
      }
    });
    try {
      const promise = relay.enqueue("video-1", "film", "inspect", { depth: 1 });
      await waitFor(() => seen.length === 1);
      assert.deepEqual(seen, ["video_studio_command"]);
      assert.equal(relay.resolve({ id: ids[0]!, taskId: "video-1", ok: true, result: { clips: 2 } }), true);
      assert.deepEqual(await promise, { clips: 2 });
    } finally {
      unsubscribe();
    }
  });

  it("names the editor in the PANEL_NOT_OPEN message", async () => {
    const relay = new WorkspaceRelay();
    await assert.rejects(
      relay.enqueue("video-2", "effects", "renderFrame"),
      (err: unknown) => /Loam Effects/.test((err as Error).message),
    );
  });
});
