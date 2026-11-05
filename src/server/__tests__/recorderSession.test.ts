import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { setRecordingDelivery } from "../recorder/chatDelivery.js";
import { CONSENT_TTL_MS, RECORDER_METHODS, RecorderSession } from "../recorder/session.js";
import { desktopGrabArgs, type CaptureFactory } from "../recorder/ffmpegCapture.js";
import { cursorPointFromSample } from "../recorder/cursorSampler.js";
import { wgcConfig } from "../recorder/wgcCapture.js";
import { zoomRegionsFromOps, zoomSceneJson } from "../recorder/zoomScene.js";
import { createLoamRecorderTools } from "../../tools/loamRecorder.js";
import { classifyIntentByKeywords } from "../intentKeywords.js";

const require = createRequire(import.meta.url);
const { METHODS, isRecorderChannel } = require("../../../electron/recorder/allowlist.cjs") as {
  METHODS: string[];
  isRecorderChannel: (channel: string) => boolean;
};
const { createFeed } = require("../../../electron/recorder/indicator.cjs") as {
  createFeed: (ui: { showCountdown: (seconds: number) => void; showRecording: () => void; clear: () => void }) => {
    push: (chunk: string) => void;
    sessionId: () => string;
  };
};

const ready = { distInstalled: true, helperOk: true, compositorOk: true, captionsBackend: "creative_subtitles" as const };
const bare = { distInstalled: false, helperOk: false, compositorOk: false, captionsBackend: "missing" as const };

function fakeFactory(dir: string): CaptureFactory {
  return {
    start() {
      const file = path.join(dir, "recording.mp4");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, "video");
      return {
        async pause() { fs.appendFileSync(file, ":pause"); },
        async resume() { fs.appendFileSync(file, ":resume"); },
        async stop() { return { file }; },
        async discard() { fs.rmSync(file, { force: true }); },
      };
    },
  };
}

describe("Loam Recorder session", () => {
  it("rejects an unknown channel and agrees with the main-process allow-list", async () => {
    assert.deepEqual([...RECORDER_METHODS], METHODS);
    assert.equal(isRecorderChannel("record.start"), true);
    assert.equal(isRecorderChannel("electronAPI.anything"), false);
    const result = await new RecorderSession(bare).call("shell", {});
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "UNKNOWN_CHANNEL");
    assert.equal(result.error?.retrySafe, false);
  });

  it("refuses to record without a live consent token", async () => {
    const now = 1_000_000;
    const session = new RecorderSession(ready, () => now);
    const missing = await session.call("record.start", { sourceId: "screen:1", consentToken: "nope" });
    assert.equal(missing.error?.code, "CONSENT_REQUIRED");
    const grant = session.issueConsent({ sourceId: "screen:1", systemAudio: true, mic: false, webcam: false });
    let clock = now;
    const expiring = new RecorderSession(ready, () => clock);
    const short = expiring.issueConsent({ sourceId: "screen:1", systemAudio: false, mic: false, webcam: false });
    clock += CONSENT_TTL_MS + 1;
    assert.equal((await expiring.call("record.start", { sourceId: "screen:1", consentToken: short.consentToken })).error?.code, "CONSENT_REQUIRED");
    const started = await session.call("record.start", { sourceId: "screen:1", consentToken: grant.consentToken, countdownSec: 3 });
    assert.equal(started.ok, true);
    const again = await session.call("record.start", { sourceId: "screen:1", consentToken: grant.consentToken });
    assert.equal(again.error?.code, "CONSENT_REQUIRED");
  });

  it("does not start a session when no capture backend exists", async () => {
    const session = new RecorderSession(bare);
    const grant = session.issueConsent({ sourceId: "screen:1", systemAudio: true, mic: false, webcam: false });
    const started = await session.call("record.start", { sourceId: "screen:1", consentToken: grant.consentToken });
    assert.equal(started.error?.code, "HELPER_MISSING");
    const status = await session.call("status", {});
    assert.equal((status.result as { state: string }).state, "idle");
    const sources = await session.call("sources.list", {});
    assert.equal(sources.error?.code, "HELPER_MISSING");
  });

  it("stops into a project and can hand that project to Loam Video", async () => {
    let now = 5_000;
    const session = new RecorderSession(ready, () => now);
    const grant = session.issueConsent({ sourceId: "screen:1", systemAudio: true, mic: false, webcam: false });
    const started = await session.call("record.start", { sourceId: "screen:1", consentToken: grant.consentToken, countdownSec: 0 });
    const sessionId = (started.result as { sessionId: string }).sessionId;
    now += 30_000;
    const stopped = await session.call("record.stop", { sessionId });
    assert.equal(stopped.ok, true);
    assert.match(String((stopped.result as { project: string }).project), /\.loamrec$/);
    const handoff = await session.call("handoff.video", {});
    assert.equal((handoff.result as { target: string }).target, "loam-video");
  });

  it("records through an injected capture and lists only the desktop", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-recorder-"));
    try {
      const session = new RecorderSession(bare, () => 10_000, fakeFactory(dir));
      const sources = await session.call("sources.list", {});
      const listed = sources.result as Array<{ id: string; name: string }>;
      assert.deepEqual(listed.map((item) => item.id), ["desktop"]);
      assert.equal(JSON.stringify(listed).includes("title"), false);
      const grant = session.issueConsent({ sourceId: "desktop", systemAudio: true, mic: false, webcam: false });
      const started = await session.call("record.start", {
        sourceId: "desktop",
        consentToken: grant.consentToken,
        countdownSec: 0,
        workspace: dir,
      });
      const sessionId = (started.result as { sessionId: string }).sessionId;
      await session.call("record.pause", { sessionId });
      await session.call("record.resume", { sessionId });
      const stopped = await session.call("record.stop", { sessionId });
      assert.equal(stopped.ok, true);
      const project = String((stopped.result as { project: string }).project);
      assert.equal(project.includes(`${path.sep}recordings${path.sep}`), true);
      assert.equal(project.includes(`${path.sep}.loam${path.sep}`), false);
      assert.equal(fs.existsSync(project), true);
      assert.equal(fs.existsSync(path.join(path.dirname(project), "recording.mp4")), true);
      const saved = JSON.parse(fs.readFileSync(project, "utf8")) as { video: string };
      assert.equal(saved.video, "recording.mp4");
      const exported = await session.call("export", { format: "mp4" });
      assert.equal((exported.result as { bytes: number }).bytes, fs.statSync(path.join(dir, "recording.mp4")).size);
      assert.equal((stopped.result as { tracks: { audio: boolean } }).tracks.audio, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes a physical cursor sample and keeps the track beside the visible recording", async () => {
    const point = cursorPointFromSample({
      type: "sample",
      timestampMs: 1_500,
      x: 192,
      y: 540,
      visible: true,
      leftButtonPressed: true,
      bounds: null,
    }, 1_000, { x: 0, y: 0, width: 1920, height: 1080 });
    assert.equal(point?.cx, 0.1);
    assert.equal(point?.cy, 0.5);
    assert.equal(point?.timeMs, 500);
    assert.equal(point?.interactionType, "click");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-cursor-"));
    try {
      const session = new RecorderSession(bare, () => 5_000, fakeFactory(dir));
      const grant = session.issueConsent({ sourceId: "desktop", systemAudio: false, mic: false, webcam: false });
      const started = await session.call("record.start", { sourceId: "desktop", consentToken: grant.consentToken, countdownSec: 0, cursor: true, workspace: dir });
      fs.writeFileSync(path.join(dir, "recording.mp4.cursor.json"), "{\"samples\":[]}");
      const stopped = await session.call("record.stop", { sessionId: (started.result as { sessionId: string }).sessionId });
      assert.equal((stopped.result as { tracks: { cursor: boolean } }).tracks.cursor, true);
      assert.equal(fs.existsSync(path.join(dir, "recordings", "recording.mp4.cursor.json")), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("burns click zoom into the file the chat receives", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-zoom-chat-"));
    const delivered: string[] = [];
    setRecordingDelivery((item) => delivered.push(item.videoPath));
    try {
      const session = new RecorderSession(ready, () => 5_000, fakeFactory(dir), null, async (_input, output) => {
        fs.writeFileSync(output, "zoomed-1080");
        return { path: output, bytes: 12 };
      });
      const grant = session.issueConsent({ sourceId: "desktop", systemAudio: false, mic: false, webcam: false });
      const started = await session.call("record.start", {
        sourceId: "desktop",
        consentToken: grant.consentToken,
        countdownSec: 0,
        cursor: true,
        workspace: dir,
        taskId: "task_zoom",
      });
      fs.writeFileSync(path.join(dir, "recording.mp4.cursor.json"), "{\"samples\":[{\"interactionType\":\"click\"}]}");
      const stopped = await session.call("record.stop", { sessionId: (started.result as { sessionId: string }).sessionId });
      assert.equal(stopped.ok, true);
      const project = String((stopped.result as { project: string }).project);
      const saved = JSON.parse(fs.readFileSync(project, "utf8")) as { video: string };
      assert.equal(saved.video, "export-zoom.mp4");
      assert.equal(fs.existsSync(path.join(dir, "recordings", "export-zoom.mp4")), true);
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0]?.endsWith(`${path.sep}recordings${path.sep}export-zoom.mp4`), true);
      const handoff = await session.call("handoff.video", {});
      assert.equal((handoff.result as { path: string }).path.endsWith(`${path.sep}export-zoom.mp4`), true);
    } finally {
      setRecordingDelivery(undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("asks the Windows helper for system audio and the cursor", () => {
    const config = wgcConfig("C:\\rec\\recording.mp4", { cursor: true, systemAudio: true });
    assert.equal(config.captureSystemAudio, true);
    assert.equal(config.captureCursor, true);
    assert.equal(config.screenPath, "C:\\rec\\recording.mp4");
    assert.equal(JSON.stringify(config).includes("title"), false);
  });

  it("writes an Arabic caption file beside the recording", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-caption-"));
    try {
      const session = new RecorderSession(bare, () => 10_000, fakeFactory(dir), {
        async generate(video) {
          const srt = `${video}.srt`;
          fs.writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,000\nمرحبا بكم في قطر\n");
          return { segments: 1, path: srt };
        },
      });
      const grant = session.issueConsent({ sourceId: "desktop", systemAudio: false, mic: false, webcam: false });
      const started = await session.call("record.start", { sourceId: "desktop", consentToken: grant.consentToken, countdownSec: 0, workspace: dir });
      const sessionId = (started.result as { sessionId: string }).sessionId;
      await session.call("record.stop", { sessionId });
      const captions = await session.call("captions.generate", { lang: "ar" });
      assert.equal(captions.ok, true);
      const saved = fs.readFileSync((captions.result as { path: string }).path, "utf8");
      assert.match(saved, /مرحبا بكم في قطر/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds a gdigrab command that can hide the cursor", () => {
    const hidden = desktopGrabArgs("clip.mp4", false).join(" ");
    assert.match(hidden, /gdigrab/);
    assert.match(hidden, /-draw_mouse 0/);
    assert.doesNotMatch(hidden, /wasapi/);
  });

  it("routes an Arabic screen-recording request to the media studio", () => {
    const intent = classifyIntentByKeywords("سجل شاشتي");
    assert.equal(intent.mode, "media");
    assert.equal(intent.decisive, true);
  });

  it("the agent tool cannot approve its own recording", async () => {
    const tool = createLoamRecorderTools({ session: new RecorderSession(ready), root: process.cwd() })[0]!;
    const result = await tool.run({ method: "record.start", params: { sourceId: "screen:1", workspace: "C:\\secret" } }, { workspace: "" } as never);
    assert.equal(result.ok, false);
    assert.match(result.content, /موافقتك/);
    const unknown = await tool.run({ method: "shell", params: {} }, { workspace: "" } as never);
    assert.match(unknown.content, /Rejected recorder channel/);
  });

  it("opens a sample project and waits for a recording before zoom", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-sample-"));
    try {
      const project = path.join(dir, "desktop.loamrec");
      fs.writeFileSync(project, JSON.stringify({ kind: "loamrec", version: 1, video: "desktop.mp4", durationMs: 30_000 }));
      const session = new RecorderSession(ready);
      const opened = await session.call("project.open", { path: project });
      assert.equal(opened.ok, true);
      assert.equal((opened.result as { durationMs: number }).durationMs, 30_000);
      const inspect = await session.call("project.inspect", {});
      assert.deepEqual((inspect.result as { zooms: unknown[] }).zooms, []);
      const zoom = await session.call("edit.apply", { ops: [{ op: "zoom.autoFromClicks" }] });
      assert.equal(zoom.ok, false);
      assert.equal(zoom.error?.code, "NOT_READY");
      const missing = await session.call("captions.generate", { lang: "ar" });
      assert.equal(missing.error?.code, "CAPTIONS_MISSING");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drives the tray feed from server state lines", () => {
    const seen: string[] = [];
    const feed = createFeed({
      showCountdown(seconds) { seen.push(`countdown:${seconds}`); },
      showRecording() { seen.push("recording"); },
      clear() { seen.push("clear"); },
    });
    feed.push('noise\nloam-recorder-state {"state":"countdown","sessionId":"abc","seconds":3}\n');
    feed.push('loam-recorder-state {"state":"recording","sessionId":"abc"}\n');
    assert.equal(feed.sessionId(), "abc");
    feed.push('loam-recorder-state {"state":"idle"}\n');
    assert.deepEqual(seen, ["countdown:3", "recording", "clear"]);
    assert.equal(feed.sessionId(), "");
  });

  it("turns click zoom into a compositor scene", () => {
    const regions = zoomRegionsFromOps([{ op: "zoom.autoFromClicks" }], 12);
    assert.equal(regions.length, 1);
    assert.equal(regions[0]?.focusMode, "auto");
    assert.equal(regions[0]?.scale, 2);
    const scene = JSON.parse(zoomSceneJson(regions)) as { zoomRegions: Array<{ focusMode: string }> };
    assert.equal(scene.zoomRegions[0]?.focusMode, "auto");
  });

  it("reads the Arabic caption that ships with the sample project", async () => {
    const session = new RecorderSession(ready);
    const opened = await session.call("project.open", { sample: true });
    assert.equal(opened.ok, true);
    const captions = await session.call("captions.generate", { lang: "ar" });
    assert.equal(captions.ok, true);
    assert.equal((captions.result as { backend: string }).backend, "sample");
    const saved = fs.readFileSync((captions.result as { path: string }).path, "utf8");
    assert.match(saved, /مرحبا بكم في قطر/);
  });
});
