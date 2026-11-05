// Arabic request, user consent, then the recording the chat scan can attach.
// The model is scripted. The consent token comes from the user window, not the tool.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { CaptureFactory } from "../recorder/ffmpegCapture.js";
import type { ChatEvent, ServerEnvelope } from "../../protocol/types.js";

function factory(): CaptureFactory {
  return {
    start(input) {
      const file = path.join(input.directory, "recording.mp4");
      fs.mkdirSync(input.directory, { recursive: true });
      fs.writeFileSync(file, "video");
      return {
        async pause() {},
        async resume() {},
        async stop() { return { file }; },
        async discard() { fs.rmSync(file, { force: true }); },
      };
    },
  };
}

describe("recorder chat delivery", () => {
  it("waits for consent and leaves the MP4 where the chat scan can see it", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-rec-chat-"));
    const configFile = path.join(workspace, "config.json");
    fs.writeFileSync(configFile, JSON.stringify({
      model: "test-model",
      ollamaUrl: "http://127.0.0.1:9",
      workspace,
      memory: { enabled: false },
      screen: { enabled: false },
      selfImprove: { enabled: false },
      computerUse: { enabled: false },
      coding: { enabled: false, chain: [] },
      failover: { providers: [] },
      mcpServers: {},
    }));
    process.env.LOAM_CONFIG = configFile;
    try {
      const { loadConfig } = await import("../../config.js");
      const { runAgent } = await import("../../agent/loop.js");
      const { ToolRegistry } = await import("../../tools/registry.js");
      const { createLoamRecorderTools } = await import("../../tools/loamRecorder.js");
      const { RecorderSession } = await import("../recorder/session.js");
      const { classifyIntentByKeywords } = await import("../intentKeywords.js");
      const { snapshotWorkspaceFiles } = await import("../../protocol/socket.js");
      const { setRecordingDelivery } = await import("../recorder/chatDelivery.js");
      const { attachRecordingDelivery } = await import("../../protocol/recorderDelivery.js");

      const intent = classifyIntentByKeywords("سجل شاشتي");
      assert.equal(intent.mode, "media");
      assert.equal(intent.decisive, true);

      const session = new RecorderSession(
        { distInstalled: true, helperOk: true, compositorOk: true, captionsBackend: "creative_subtitles" },
        () => 20_000,
        factory(),
      );
      const registry = new ToolRegistry();
      registry.registerAll(createLoamRecorderTools({ session }));
      const cfg = loadConfig();
      cfg.workspace = workspace;
      cfg.model = "test-model";
      cfg.coding = { enabled: false, chain: [], logEdits: false };

      let step = 0;
      const ollama = {
        async chat() {
          step += 1;
          const usage = { promptTokens: 1, completionTokens: 1, durationMs: 0 };
          if (step === 1) {
            return {
              content: "",
              model: "test-model",
              usage,
              toolCalls: [{ function: { name: "loam_recorder", arguments: { method: "record.start", params: { sourceId: "desktop" } } } }],
            };
          }
          return { content: "بانتظار موافقتك في نافذة Loam Recorder.", model: "test-model", usage, toolCalls: [] };
        },
      };

      const result = await runAgent({
        cfg,
        ollama: ollama as never,
        tools: registry,
        emit() {},
        prompt: "سجل شاشتي",
        taskId: "task_rec_chat",
        suppressFinal: true,
        maxSteps: 4,
        systemOverride: "test",
      });

      const toolMessages = result.messages.filter((message) => message.role === "tool");
      assert.equal(toolMessages.length, 1);
      assert.match(toolMessages.map((message) => message.content).join("\n"), /موافقتك/);
      const frames: { sessionId: string; path: string }[] = [];
      const unbind = attachRecordingDelivery({
        getSessionByTaskId(taskId) {
          return taskId === "task_rec_chat" ? { sessionId: "ses_rec" } as never : undefined;
        },
        appendEvent(sessionId, frame) {
          const event = frame.event as { path?: string };
          if (event.path) frames.push({ sessionId, path: event.path });
        },
      }, {
        to(sessionId) {
          return {
            emit(_event: string, frame: ServerEnvelope<ChatEvent>) {
              const event = frame.event as { path?: string };
              frames.push({ sessionId, path: `emit:${event.path ?? ""}` });
            },
          };
        },
      });
      try {
        const grant = session.issueConsent({ sourceId: "desktop", systemAudio: false, mic: false, webcam: false });
        const started = await session.call("record.start", { sourceId: "desktop", consentToken: grant.consentToken, countdownSec: 0 });
        assert.equal(started.ok, true);
        const sessionId = (started.result as { sessionId: string }).sessionId;
        const stopped = await session.call("record.stop", { sessionId });
        assert.equal(stopped.ok, true);
      } finally {
        unbind();
        setRecordingDelivery(undefined);
      }
      const seen = snapshotWorkspaceFiles(workspace).map((file) => file.rel);
      assert.equal(seen.includes("recordings/recording.mp4"), true);
      assert.equal(seen.some((name) => name.split("/").includes(".loam")), false, seen.join(" | "));
      assert.equal(frames.some((frame) => frame.sessionId === "ses_rec" && frame.path === "recordings/recording.mp4"), true);
      assert.equal(frames.some((frame) => frame.path === "emit:recordings/recording.mp4"), true);
    } finally {
      delete process.env.LOAM_CONFIG;
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
