import fs from "node:fs";
import type { Config } from "../config.js";
import type { Emit, Usage } from "./events.js";
import type { ToolRegistry } from "../tools/registry.js";
import { requireTaskWorkspace, taskPath } from "../server/taskWorkspace.js";
import { probeVideo } from "../server/workspace/videoRender.js";
import { renderPresentationVideo, type PresentationVideoRenderResult } from "../server/workspace/presentationVideoRender.js";
import { readPackProject, writePackProject } from "../packs/present.js";
import { completePackTask } from "../tools/finishTools.js";
import type { PackId } from "../packs/types.js";

export function presentationVideoRequest(prompt: string, mode: string): boolean {
  return mode === "media"
    && /أنشئ فيديو MP4 من العرض التقديمي|Create an MP4 video from the presentation/i.test(prompt)
    && /صورة الشريحة الجاهزة للاستيراد|Slide preview path/i.test(prompt);
}

interface PresentationVideoOptions {
  cfg: Config;
  tools: ToolRegistry;
  emit: Emit;
  prompt: string;
  taskId: string;
  signal?: AbortSignal;
  packId?: PackId;
  studioAvailable?: () => boolean;
  renderLocal?: (taskRoot: string, previewPath: string, signal?: AbortSignal) => Promise<PresentationVideoRenderResult>;
  probe?: typeof probeVideo;
}

export interface PresentationVideoResult {
  text: string;
  steps: number;
  model: string;
  usage: Usage;
  verified: true;
}

function previewFromPrompt(prompt: string): string {
  const value = prompt.match(/صورة الشريحة الجاهزة للاستيراد:\s*([^\r\n]+)/i)?.[1]
    ?? prompt.match(/Slide preview path:\s*([^\r\n]+)/i)?.[1]
    ?? "";
  const preview = value.trim().replace(/\\/g, "/");
  if (!/^previews\/[a-z0-9._-]+\.png$/i.test(preview)) throw new Error("presentation video needs a safe PNG preview path");
  return preview;
}

function videoPath(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { path?: unknown };
    if (typeof parsed.path === "string" && /\.mp4$/i.test(parsed.path)) return parsed.path;
  } catch {
    const match = content.match(/(?:exports|uploads)\/[^"\s]+\.mp4/i);
    if (match) return match[0];
  }
  return null;
}

export async function runPresentationVideoFastPath(opts: PresentationVideoOptions): Promise<PresentationVideoResult> {
  const arabic = /[\u0590-\u08ff]/.test(opts.prompt);
  const root = requireTaskWorkspace(opts.taskId, opts.cfg.workspace);
  if (opts.packId === "loam-video" && !readPackProject(root, "loam-video")) {
    writePackProject(root, { projectId: opts.taskId, packId: "loam-video", revision: 0, items: [{ id: "video-1", state: "pending" }] });
  }
  const preview = previewFromPrompt(opts.prompt);
  const png = fs.readFileSync(taskPath(root, preview));
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("presentation preview is not a valid PNG");
  const renderLocal = opts.renderLocal ?? renderPresentationVideo;
  const probe = opts.probe ?? probeVideo;
  const steps = [
    { id: "prepare", title: arabic ? "تجهيز معاينة العرض" : "Preparing the slide preview", instruction: "Validate the rendered slide", successCriteria: "A valid PNG exists" },
    { id: "studio", title: arabic ? "تجهيز Loam Video" : "Preparing Loam Video", instruction: "Open the studio, read state, and import the preview when available", successCriteria: "The timeline accepts the slide or the local fallback is selected" },
    { id: "render", title: arabic ? "إنتاج الفيديو" : "Rendering the video", instruction: "Apply gentle motion and export an eight-second MP4", successCriteria: "An MP4 is written" },
    { id: "verify", title: arabic ? "التحقق من الفيديو" : "Verifying the video", instruction: "Probe the rendered file and publish it", successCriteria: "The MP4 has a valid duration and size" },
  ];
  const emitPlan = (done: number) => opts.emit({
    type: "plan",
    goal: arabic ? "إنشاء فيديو من العرض" : "Create a video from the presentation",
    trivial: false,
    source: "fallback",
    steps: steps.map((step, index) => ({ ...step, status: index < done ? "done" : index === done ? "doing" : "pending" })),
  });
  emitPlan(0);
  emitPlan(1);

  const call = async (args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> => {
    opts.emit({ type: "tool_call", name: "video_studio", args });
    const result = await opts.tools.exec("video_studio", args, {
      cfg: opts.cfg,
      workspace: opts.cfg.workspace,
      emit: opts.emit,
      taskId: opts.taskId,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    opts.emit({ type: "tool_result", name: "video_studio", ok: result.ok, summary: result.content.slice(0, 1000) });
    return result;
  };

  let relative: string | null = null;
  let bytes = 0;
  let duration = 0;
  let hasAudio = false;
  let method: "studio" | "local" = "studio";
  const studioAttempted = opts.studioAvailable?.() ?? false;
  let opened = studioAttempted ? await call({ action: "open" }) : { ok: false, content: "panel_not_open" };
  if (opened.ok) opened = await call({ action: "state" });
  if (opened.ok) opened = await call({ action: "import", path: preview });
  if (opened.ok) opened = await call({ action: "transition_basic", atSec: 0, durationSec: 0.6, type: "fade" });
  if (opened.ok) {
    const exported = await call({ action: "export", format: "mp4", name: "presentation-video", width: 1920, height: 1080, quality: "high" });
    const candidate = exported.ok ? videoPath(exported.content) : null;
    if (candidate) {
      try {
        const metadata = await probe(taskPath(root, candidate));
        if (metadata.duration && metadata.bytes > 1_000) {
          relative = candidate;
          bytes = metadata.bytes;
          duration = metadata.duration;
          hasAudio = metadata.hasAudio;
        }
      } catch {
        relative = null;
      }
    }
  }

  emitPlan(2);
  if (!relative) {
    method = "local";
    opts.emit({ type: "tool_call", name: "presentation_video_render", args: { path: preview, durationSec: 8, motion: "gentle-zoom-and-fades" } });
    const rendered = await renderLocal(root, preview, opts.signal);
    relative = rendered.path;
    bytes = rendered.bytes;
    duration = rendered.duration;
    hasAudio = rendered.hasAudio;
    const content = JSON.stringify({ path: relative, ...(rendered.previewPath ? { previewPath: rendered.previewPath } : {}), ...(rendered.reviewFrames ? { reviewFrames: rendered.reviewFrames } : {}), ...(rendered.motionPlanPath ? { motionPlanPath: rendered.motionPlanPath } : {}), mime: "video/mp4", bytes, durationSec: duration, fallback: "local-ffmpeg" });
    opts.emit({ type: "tool_result", name: "presentation_video_render", ok: true, summary: content, content });
  }
  if (!relative || bytes <= 1_000 || duration <= 0) throw new Error("presentation video did not produce a valid MP4");
  let resourceUri = "";
  if (opts.packId === "loam-video") {
    const project = readPackProject(root, "loam-video");
    if (!project) throw new Error("video pack project disappeared before presentation");
    project.items = [{ id: "video-1", state: "final", path: relative }];
    project.data = { ...project.data, durationSec: duration, renderer: method };
    writePackProject(root, { ...project, revision: project.revision + 1 });
    const completion = await completePackTask({ cfg: opts.cfg, workspace: root, emit: opts.emit, taskId: opts.taskId, packId: opts.packId, ...(opts.signal ? { signal: opts.signal } : {}) }, [relative]);
    if (!completion.ok) throw new Error(`video_present failed: ${completion.content}`);
    resourceUri = completion.pack?.ok ? completion.pack.uri : "";
  }
  emitPlan(3);
  emitPlan(4);
  const seconds = Math.round(duration * 10) / 10;
  const text = (arabic
    ? `تم إنشاء فيديو MP4 من العرض بمدة ${seconds} ثوانٍ${hasAudio ? "" : " ودون تعليق صوتي"}${method === "local" ? studioAttempted ? " باستخدام العارض المحلي بعد تعذر المحرر المباشر" : " بالعارض المحلي المخصص للشرائح" : ""}:\n\n${relative}`
    : `Created a ${seconds}s MP4 from the presentation${hasAudio ? "" : " without voiceover"}${method === "local" ? studioAttempted ? " using the local renderer because the live editor was unavailable" : " with the dedicated slide renderer" : ""}:\n\n${relative}`) + (resourceUri ? `\n\n${resourceUri}` : "");
  opts.emit({ type: "verify", verdict: "pass", reason: `MP4 verified: ${seconds}s, ${bytes} bytes, ${method} renderer.` });
  opts.emit({ type: "assistant_message", text });
  opts.emit({ type: "done", text, steps: 4, model: "presentation-video-pipeline" });
  return { text, steps: 4, model: "presentation-video-pipeline", usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 }, verified: true };
}
