import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { CONSENT_TTL_MS, RECORDER_METHODS, RecorderSession } from "../recorder/session.js";
import { desktopGrabArgs, type CaptureFactory } from "../recorder/ffmpegCapture.js";
import { createLoamRecorderTools } from "../../tools/loamRecorder.js";

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
      assert.equal(fs.existsSync(project), true);
      const saved = JSON.parse(fs.readFileSync(project, "utf8")) as { video: string };
      assert.equal(saved.video, "recording.mp4");
      const exported = await session.call("export", { format: "mp4" });
      assert.equal((exported.result as { bytes: number }).bytes, fs.statSync(path.join(dir, "recording.mp4")).size);
      assert.equal((stopped.result as { tracks: { audio: boolean } }).tracks.audio, false);
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

  it("the agent tool cannot approve its own recording", async () => {
    const tool = createLoamRecorderTools({ session: new RecorderSession(ready), root: process.cwd() })[0]!;
    const result = await tool.run({ method: "record.start", params: { sourceId: "screen:1", workspace: "C:\\secret" } }, { workspace: "" } as never);
    assert.equal(result.ok, false);
    assert.match(result.content, /موافقتك/);
    const unknown = await tool.run({ method: "shell", params: {} }, { workspace: "" } as never);
    assert.match(unknown.content, /Rejected recorder channel/);
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
});
