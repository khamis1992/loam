/**
 * Unit tests for the fc-05 state-sync helpers (src/tools/videoStudioState.ts).
 *
 * These cover the manual-edit detection contract: the compact timeline summary,
 * the fingerprint, the added/removed/moved clip diff and the manual-edit notice.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import type { VideoStudioRelayLike } from "../videoStudio.js";

import {
  VIDEO_STUDIO_PROJECT_FILE,
  VideoStudioProjectStore,
  VideoStudioStateTracker,
  diffProjectStates,
  formatStateDiff,
  hashProjectState,
  summarizeProjectState,
  type VideoStudioStateSummary,
} from "../videoStudioState.js";

after(() => {
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const dirs: string[] = [];

function project(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    durationSec: 10,
    playheadSec: 0,
    selection: [],
    tracks: [
      { id: "v1", kind: "video", clips: [{ id: "clip_1", startSec: 0, endSec: 5, sourceInSec: 0, sourceOutSec: 5, name: "a.mp4" }] },
      { id: "a1", kind: "audio", clips: [{ id: "clip_2", startSec: 0, endSec: 10, name: "voice.mp3" }] },
      { id: "t1", kind: "text", clips: [{ id: "clip_3", text: "Hello", startSec: 1, endSec: 4 }] },
    ],
    ...overrides,
  };
}

describe("summarizeProjectState", () => {
  it("summarises tracks, clips, text layers and audio clips", () => {
    const summary = summarizeProjectState(project());
    assert.equal(summary.tracks.length, 3);
    assert.equal(summary.clips.length, 3);
    assert.equal(summary.textLayers.length, 1);
    assert.equal(summary.textLayers[0]!.text, "Hello");
    assert.equal(summary.audioClips.length, 1);
    assert.equal(summary.audioClips[0]!.name, "voice.mp3");
    assert.equal(summary.clips[0]!.trackId, "v1");
    assert.equal(summary.durationSec, 10);
  });

  it("degrades to an empty summary for an unrecognisable payload", () => {
    const summary = summarizeProjectState({ nope: true });
    assert.equal(summary.clips.length, 0);
    assert.equal(summary.tracks.length, 0);
    assert.equal(summary.durationSec, null);
    // It must never throw.
    summarizeProjectState(undefined);
    summarizeProjectState([1, 2, 3]);
  });

  it("derives the duration from the last clip when none is reported", () => {
    const summary = summarizeProjectState({ durationSec: undefined, clips: [{ id: "c1", startSec: 0, endSec: 7 }] });
    assert.equal(summary.durationSec, 7);
  });
});

describe("hashProjectState", () => {
  it("is stable and insensitive to key order", () => {
    const a = summarizeProjectState(project());
    const b = summarizeProjectState(JSON.parse(JSON.stringify(project())));
    assert.equal(hashProjectState(a), hashProjectState(b));
  });

  it("changes when a clip moves", () => {
    const before = summarizeProjectState(project());
    const after = summarizeProjectState(project({
      tracks: [{ id: "v1", kind: "video", clips: [{ id: "clip_1", startSec: 2, endSec: 7, sourceInSec: 0, sourceOutSec: 5, name: "a.mp4" }] }],
    }));
    assert.notEqual(hashProjectState(before), hashProjectState(after));
  });
});

describe("diffProjectStates + formatStateDiff", () => {
  it("reports an added clip", () => {
    const before = summarizeProjectState(project());
    const after = summarizeProjectState({
      durationSec: 12,
      tracks: [
        ...(project().tracks as unknown[]),
        { id: "v2", kind: "video", clips: [{ id: "clip_9", startSec: 10, endSec: 12 }] },
      ],
    });
    const diff = diffProjectStates(before, after);
    assert.deepEqual(diff.added.map((c) => c.id), ["clip_9"]);
    assert.deepEqual(diff.removed, []);
    const text = formatStateDiff(diff);
    assert.match(text, /\+clip clip_9/);
    assert.match(text, /~duration/);
  });

  it("reports a removed clip", () => {
    const before = summarizeProjectState(project());
    const after = summarizeProjectState({ tracks: [{ id: "v1", kind: "video", clips: [] }] });
    const diff = diffProjectStates(before, after);
    assert.deepEqual(diff.removed.map((c) => c.id).sort(), ["clip_1", "clip_2", "clip_3"]);
    assert.match(formatStateDiff(diff), /-clip clip_1/);
  });

  it("reports a moved clip with its from/to position", () => {
    const before = summarizeProjectState(project());
    const after = summarizeProjectState(project({
      tracks: [
        { id: "v1", kind: "video", clips: [{ id: "clip_1", startSec: 3, endSec: 8, sourceInSec: 0, sourceOutSec: 5, name: "a.mp4" }] },
        { id: "a1", kind: "audio", clips: [{ id: "clip_2", startSec: 0, endSec: 10, name: "voice.mp3" }] },
        { id: "t1", kind: "text", clips: [{ id: "clip_3", text: "Hello", startSec: 1, endSec: 4 }] },
      ],
    }));
    const diff = diffProjectStates(before, after);
    assert.equal(diff.moved.length, 1);
    assert.equal(diff.moved[0]!.clip.id, "clip_1");
    assert.equal(diff.moved[0]!.fromStartSec, 0);
    assert.equal(diff.moved[0]!.toStartSec, 3);
    assert.match(formatStateDiff(diff), /~clip clip_1 0s->3s/);
  });

  it("reports added and removed text", () => {
    const before = summarizeProjectState(project());
    const after = summarizeProjectState(project({
      tracks: [
        { id: "v1", kind: "video", clips: [{ id: "clip_1", startSec: 0, endSec: 5, sourceInSec: 0, sourceOutSec: 5, name: "a.mp4" }] },
        { id: "a1", kind: "audio", clips: [{ id: "clip_2", startSec: 0, endSec: 10, name: "voice.mp3" }] },
        { id: "t1", kind: "text", clips: [{ id: "clip_3", text: "Bye", startSec: 1, endSec: 4 }] },
      ],
    }));
    const diff = diffProjectStates(before, after);
    assert.deepEqual(diff.addedText, ["Bye"]);
    assert.deepEqual(diff.removedText, ["Hello"]);
  });
});

describe("VideoStudioStateTracker", () => {
  it("emits a manual-edit notice only when the hash differs", () => {
    const tracker = new VideoStudioStateTracker();
    const first = tracker.observe("task_1", project());
    assert.equal(first.changed, false);
    assert.equal(first.notice, null);

    // The user dragged the clip by hand: a manual-edit notice is produced.
    const ownEdit = tracker.observe("task_1", project({
      tracks: [
        { id: "v1", kind: "video", clips: [{ id: "clip_1", startSec: 3, endSec: 8, sourceInSec: 0, sourceOutSec: 5, name: "a.mp4" }] },
        { id: "a1", kind: "audio", clips: [{ id: "clip_2", startSec: 0, endSec: 10, name: "voice.mp3" }] },
        { id: "t1", kind: "text", clips: [{ id: "clip_3", text: "Hello", startSec: 1, endSec: 4 }] },
      ],
    }));
    assert.equal(ownEdit.changed, true);
    assert.match(ownEdit.notice!, /User edited the timeline manually since your last action/);

    // Re-observing the same state is stable.
    const stable = tracker.observe("task_1", project({
      tracks: [
        { id: "v1", kind: "video", clips: [{ id: "clip_1", startSec: 3, endSec: 8, sourceInSec: 0, sourceOutSec: 5, name: "a.mp4" }] },
        { id: "a1", kind: "audio", clips: [{ id: "clip_2", startSec: 0, endSec: 10, name: "voice.mp3" }] },
        { id: "t1", kind: "text", clips: [{ id: "clip_3", text: "Hello", startSec: 1, endSec: 4 }] },
      ],
    }));
    assert.equal(stable.changed, false);
    assert.equal(stable.notice, null);
  });

  it("never treats an empty read as a manual edit or as a new baseline", () => {
    const tracker = new VideoStudioStateTracker();
    const empty = { sequences: [{ id: "seq1", tracks: [], clips: [] }] };

    // First-ever read is empty (editor not loaded yet): no notice, and it must
    // not become the baseline.
    const first = tracker.observe("task_1", empty);
    assert.equal(first.changed, false);
    assert.equal(first.notice, null);
    assert.equal(tracker.lastHash("task_1"), null);

    // The next read is the real timeline. Since the empty read was not adopted,
    // this is a first sighting, not a manual edit.
    const populated = tracker.observe("task_1", project());
    assert.equal(populated.changed, false);
    assert.equal(populated.notice, null);

    // Now a real change is detected against that baseline.
    const moved = tracker.observe("task_1", project({
      tracks: [
        { id: "v1", kind: "video", clips: [{ id: "clip_1", startSec: 3, endSec: 8, name: "a.mp4" }] },
        { id: "a1", kind: "audio", clips: [{ id: "clip_2", startSec: 0, endSec: 10, name: "voice.mp3" }] },
        { id: "t1", kind: "text", clips: [{ id: "clip_3", text: "Hello", startSec: 1, endSec: 4 }] },
      ],
    }));
    assert.equal(moved.changed, true);
    assert.match(moved.notice!, /~clip clip_1 0s->3s/);

    // A transient empty read after that must not wipe the baseline either.
    const again = tracker.observe("task_1", empty);
    assert.equal(again.changed, false);
    const afterEmpty = tracker.observe("task_1", project({
      tracks: [
        { id: "v1", kind: "video", clips: [{ id: "clip_1", startSec: 3, endSec: 8, name: "a.mp4" }] },
        { id: "a1", kind: "audio", clips: [{ id: "clip_2", startSec: 0, endSec: 10, name: "voice.mp3" }] },
        { id: "t1", kind: "text", clips: [{ id: "clip_3", text: "Hello", startSec: 1, endSec: 4 }] },
      ],
    }));
    assert.equal(afterEmpty.changed, false);
  });

  it("tracks tasks independently", () => {
    const tracker = new VideoStudioStateTracker();
    tracker.observe("task_a", project());
    const b = tracker.observe("task_b", project());
    assert.equal(b.changed, false);
    assert.equal(tracker.lastHash("task_a"), hashProjectState(summarizeProjectState(project())));
  });

  it("forgets a task", () => {
    const tracker = new VideoStudioStateTracker();
    tracker.observe("task_1", project());
    tracker.forget("task_1");
    assert.equal(tracker.lastHash("task_1"), null);
  });
});

describe("VideoStudioProjectStore", () => {
  it("persists the project debounced into the task files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-store-"));
    dirs.push(dir);
    const store = new VideoStudioProjectStore({ debounceMs: 5 });
    store.schedule("task_1", dir, project());
    // Nothing has been written while the debounce window is open.
    assert.equal(fs.existsSync(path.join(dir, VIDEO_STUDIO_PROJECT_FILE)), false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(store.has("task_1", dir), true);
    const saved = store.load("task_1", dir)!;
    // The raw editor payload is stored verbatim, next to the derived summary.
    assert.deepEqual(saved.project, project());
    assert.equal(saved.summary.clips.length, 3);
    assert.ok(typeof saved.savedAt === "string");
  });

  it("coalesces rapid changes into the last one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-store-"));
    dirs.push(dir);
    const store = new VideoStudioProjectStore({ debounceMs: 20 });
    store.schedule("task_1", dir, project({ durationSec: 1 }));
    store.schedule("task_1", dir, project({ durationSec: 2 }));
    store.schedule("task_1", dir, project({ durationSec: 3 }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal((store.load("task_1", dir)!.project as { durationSec?: number }).durationSec, 3);
  });

  it("flush writes immediately", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-store-"));
    dirs.push(dir);
    const store = new VideoStudioProjectStore({ debounceMs: 60_000 });
    store.schedule("task_1", dir, project({ durationSec: 9 }));
    await store.flush("task_1");
    assert.equal((store.load("task_1", dir)!.project as { durationSec?: number }).durationSec, 9);
  });

  it("never throws on a filesystem failure and forget drops the pending write", async () => {
    const store = new VideoStudioProjectStore({ debounceMs: 5 });
    // A workspace path that cannot be created (a file used as a directory).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-store-"));
    dirs.push(dir);
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "x");
    store.schedule("task_1", path.join(blocker, "nested"), { rev: 1 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(store.load("task_1", dir), null);

    const store2 = new VideoStudioProjectStore({ debounceMs: 5 });
    store2.schedule("task_1", dir, { rev: 1 });
    store2.forget("task_1");
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(store2.has("task_1", dir), false);
  });

  it("returns null for a missing project file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-store-"));
    dirs.push(dir);
    const store = new VideoStudioProjectStore();
    assert.equal(store.load("task_1", dir), null);
  });
});

describe("video_studio tool result carries the summary", () => {
  it("includes the compact summary in every result", async () => {
    // The summary is asserted here against the real tool (the command sequence
    // itself is covered by videoStudio.test.ts).
    const { createVideoStudioTools } = await import("../videoStudio.js");
    const relay: VideoStudioRelayLike = {
      async enqueue(_taskId, _target, method) {
        if (method === "commands") return ["file.newProject", "timeline.razor", "export"];
        if (method === "inspect") return project();
        return { ok: true };
      },
    };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-summary-"));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vs-summary-ws-"));
    dirs.push(root, ws);
    fs.mkdirSync(path.join(root, "electron", "filmcraft", "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "electron", "filmcraft", "dist", "index.html"), "<html></html>");

    const tool = createVideoStudioTools({ relay, root })[0]!;
    const res = await tool.run({ action: "state" }, {
      cfg: {} as never, workspace: ws, emit: () => undefined, taskId: "task_summary",
    } as never);
    assert.equal(res.ok, true, res.content);
    const parsed = JSON.parse(res.content) as { summary: VideoStudioStateSummary; notice: null };
    assert.equal(parsed.summary.clips.length, 3);
    assert.equal(parsed.summary.textLayers.length, 1);
    assert.equal(parsed.notice, null);
  });
});
