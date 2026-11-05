import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Config } from "../../config.js";
import type { AgentEvent } from "../events.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { presentationVideoRequest, runPresentationVideoFastPath } from "../presentationVideo.js";

let dataDir = "";
let close: () => void = () => undefined;
let createTask: (prompt: string) => { id: string };
const workspaces: string[] = [];

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-presentation-video-data-"));
  process.env.MANUS_LOCAL_DATA_DIR = dataDir;
  close = (await import("../../server/sqliteStore.js")).closeDb;
  createTask = (await import("../../server/db.js")).createTask;
});

after(() => {
  close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  for (const workspace of workspaces) fs.rmSync(workspace, { recursive: true, force: true });
  delete process.env.MANUS_LOCAL_DATA_DIR;
});

const prompt = "أنشئ فيديو MP4 من العرض التقديمي الموجود في مساحة هذه المهمة.\nملف العرض: uploads/kuwait.pptx\nصورة الشريحة الجاهزة للاستيراد: previews/slide-1.png\nاستخدم video_studio";

async function setup() {
  const task = createTask(prompt);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-presentation-video-ws-"));
  workspaces.push(workspace);
  const root = path.join(workspace, ".loam-tasks", task.id);
  fs.mkdirSync(path.join(root, "previews"), { recursive: true });
  fs.writeFileSync(path.join(root, "previews", "slide-1.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { task, workspace, cfg: { workspace, model: "unused", fallbackModel: "", agent: { requestTimeoutMs: 1000, maxSteps: 2, temperature: 0 } } as Config };
}

describe("PresentationVideoPipeline", () => {
  it("detects only the presentation-video CTA in media mode", () => {
    assert.equal(presentationVideoRequest(prompt, "media"), true);
    assert.equal(presentationVideoRequest(prompt, "write"), false);
    assert.equal(presentationVideoRequest("أنشئ فيديو MP4 من العرض التقديمي", "media"), false);
  });

  it("uses the real studio sequence when it is available", async () => {
    const { task, cfg } = await setup();
    const actions: string[] = [];
    const tools = {
      async exec(_name: string, args: Record<string, unknown>) {
        actions.push(String(args.action));
        return { ok: true, content: args.action === "export" ? JSON.stringify({ path: "exports/presentation-video.mp4" }) : "{}" };
      },
    } as unknown as ToolRegistry;
    const result = await runPresentationVideoFastPath({
      cfg,
      tools,
      emit: () => {},
      prompt,
      taskId: task.id,
      studioAvailable: () => true,
      renderLocal: async () => { throw new Error("local fallback must not run"); },
      probe: async () => ({ duration: 8, bytes: 120_000, hasAudio: false, mtimeMs: 1 }),
    });
    assert.deepEqual(actions, ["open", "state", "import", "transition_basic", "export"]);
    assert.equal(result.verified, true);
    assert.match(result.text, /exports\/presentation-video\.mp4/);
    assert.equal(result.usage.promptTokens, 0);
  });

  it("renders once locally after a studio failure without an agent loop", async () => {
    const { task, cfg } = await setup();
    const events: AgentEvent[] = [];
    let localCalls = 0;
    const tools = { async exec() { return { ok: false, content: "panel_not_open" }; } } as unknown as ToolRegistry;
    const result = await runPresentationVideoFastPath({
      cfg,
      tools,
      emit: (event) => events.push(event),
      prompt,
      taskId: task.id,
      studioAvailable: () => true,
      renderLocal: async () => {
        localCalls += 1;
        return { path: "uploads/presentation-video.mp4", previewPath: "previews/presentation-video.png", bytes: 120_000, duration: 8, hasAudio: false };
      },
    });
    assert.equal(localCalls, 1);
    assert.equal(result.verified, true);
    assert.match(result.text, /دون تعليق صوتي/);
    assert.ok(events.some((event) => event.type === "tool_result" && event.name === "presentation_video_render" && event.ok));
    assert.ok(events.some((event) => event.type === "done" && event.steps === 4));
  });

  it("skips the attach timeout when no video panel is connected", async () => {
    const { task, cfg } = await setup();
    let studioCalls = 0;
    let localCalls = 0;
    const tools = { async exec() { studioCalls += 1; return { ok: true, content: "{}" }; } } as unknown as ToolRegistry;
    await runPresentationVideoFastPath({
      cfg,
      tools,
      emit: () => {},
      prompt,
      taskId: task.id,
      studioAvailable: () => false,
      renderLocal: async () => {
        localCalls += 1;
        return { path: "uploads/presentation-video.mp4", bytes: 120_000, duration: 8, hasAudio: false };
      },
    });
    assert.equal(studioCalls, 0);
    assert.equal(localCalls, 1);
  });
});
