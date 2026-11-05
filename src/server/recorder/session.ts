// Loam Recorder session. The agent and the Workspace iframe share this
// contract. Recording cannot start without a single-use consent token.
// A capture factory (ffmpeg) may record when the Windows helper is absent.
// With neither, start reports HELPER_MISSING and does not invent a file.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetUnder, ROOT } from "../../config.js";
import { deliverRecording } from "./chatDelivery.js";
import { burnClickZoomExport, exportCompositor1080, type ZoomExporter } from "./compositorExport.js";
import { zoomRegionsFromOps, zoomSceneJson, type ZoomRegion } from "./zoomScene.js";
import type { CaptureFactory } from "./ffmpegCapture.js";

export interface CaptionEngine {
  generate(video: string, lang: string): Promise<{ segments: number; path: string }>;
}

function recorderMethodsPath(): string {
  try {
    const metaUrl = import.meta.url;
    if (typeof metaUrl === "string" && metaUrl.length > 0) {
      return path.resolve(path.dirname(fileURLToPath(metaUrl)), "../../../electron/recorder/methods.json");
    }
  } catch {
    /* The packaged CJS bundle has no import.meta.url. */
  }
  try {
    if (typeof __dirname === "string" && __dirname.length > 0) {
      return path.resolve(__dirname, "../electron/recorder/methods.json");
    }
  } catch {
    /* ESM source has no __dirname. */
  }
  return path.resolve(process.cwd(), "electron/recorder/methods.json");
}

function loadRecorderMethods(): readonly string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(recorderMethodsPath(), "utf8")) as { methods?: unknown };
    const methods = Array.isArray(parsed.methods) ? parsed.methods.filter((item): item is string => typeof item === "string") : [];
    return Object.freeze(methods);
  } catch {
    return Object.freeze([]);
  }
}

export const RECORDER_METHODS: readonly string[] = loadRecorderMethods();

export const CONSENT_TTL_MS = 60_000;

export const CONSENT_REQUIRED_AR =
  "لا أستطيع بدء التسجيل إلا بعد موافقتك في نافذة Loam Recorder. لن أعيد المحاولة بنفسي.";

export interface RecorderError {
  code: string;
  message: string;
  retrySafe: false;
}

export interface RecorderCallResult {
  ok: boolean;
  result?: unknown;
  error?: RecorderError;
}

export type RecorderState = "idle" | "countdown" | "recording" | "paused" | "stopping";

export interface RecorderCapabilities {
  distInstalled: boolean;
  helperOk: boolean;
  compositorOk: boolean;
  captionsBackend: "creative_subtitles" | "missing";
}

export interface ConsentRequest {
  sourceId: string;
  systemAudio: boolean;
  mic: boolean;
  webcam: boolean;
}

interface ConsentGrant extends ConsentRequest {
  token: string;
  expiresAt: number;
  used: boolean;
}

interface LiveSession {
  id: string;
  sourceId: string;
  state: RecorderState;
  startedAt: number;
  directory: string;
  workspace?: string;
  taskId?: string;
  cursor: boolean;
  systemAudio: boolean;
  projectPath?: string;
  durationMs?: number;
}

interface OpenProject {
  projectId: string;
  durationMs: number;
  path?: string;
  video?: string;
  zooms?: ZoomRegion[];
}

function publish(state: RecorderState | "idle", sessionId?: string, seconds?: number): void {
  console.log(`loam-recorder-state ${JSON.stringify({ state, sessionId, seconds })}`);
}

function recordingDir(workspace: unknown): string {
  if (typeof workspace === "string" && workspace.trim()) {
    const root = path.resolve(workspace);
    const dir = path.resolve(root, ".loam", "recordings");
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (dir !== root && !dir.startsWith(prefix)) {
      throw new Error("Recording directory escapes the workspace.");
    }
    return dir;
  }
  return path.join(os.tmpdir(), "loam-recorder");
}

function publishVisibleRecording(workspace: string | undefined, file: string, projectPath: string, durationMs: number): { video: string; project: string } {
  if (!workspace) return { video: file, project: projectPath };
  const destDir = path.join(path.resolve(workspace), "recordings");
  fs.mkdirSync(destDir, { recursive: true });
  const video = path.join(destDir, path.basename(file));
  const project = path.join(destDir, path.basename(projectPath));
  if (path.resolve(video) !== path.resolve(file)) fs.copyFileSync(file, video);
  const sidecar = `${file}.cursor.json`;
  if (fs.existsSync(sidecar) && path.resolve(`${video}.cursor.json`) !== path.resolve(sidecar)) {
    fs.copyFileSync(sidecar, `${video}.cursor.json`);
  }
  fs.writeFileSync(project, JSON.stringify({
    kind: "loamrec",
    version: 1,
    video: path.basename(video),
    durationMs,
  }));
  return { video, project };
}

function fail(code: string, message: string): RecorderCallResult {
  return { ok: false, error: { code, message, retrySafe: false } };
}

function ok(result: unknown): RecorderCallResult {
  return { ok: true, result };
}

function countCues(file: string): number {
  const text = fs.readFileSync(file, "utf8");
  return text.split("-->").length - 1;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class RecorderSession {
  private readonly grants = new Map<string, ConsentGrant>();
  private requestedWorkspace: string | undefined;
  private requestedTaskId: string | undefined;
  private live: LiveSession | null = null;
  private project: OpenProject | null = null;
  private arm: ReturnType<typeof setTimeout> | null = null;
  private active: ReturnType<CaptureFactory["start"]> | null = null;

  constructor(
    private readonly caps: RecorderCapabilities,
    private readonly now: () => number = Date.now,
    private readonly captureFactory: CaptureFactory | null = null,
    private readonly captions: CaptionEngine | null = null,
    private readonly zoomExport: ZoomExporter = exportCompositor1080,
  ) {}

  /** Issued only by the user-facing consent route. The agent tool never calls this. */
  issueConsent(input: ConsentRequest): { consentToken: string; expiresAt: number } {
    const token = randomUUID();
    const expiresAt = this.now() + CONSENT_TTL_MS;
    this.grants.set(token, { ...input, token, expiresAt, used: false });
    return { consentToken: token, expiresAt };
  }

  async call(method: string, params: unknown): Promise<RecorderCallResult> {
    if (!RECORDER_METHODS.includes(method)) {
      return fail("UNKNOWN_CHANNEL", `Rejected recorder channel: ${method}`);
    }
    const body = asRecord(params);
    switch (method) {
      case "status":
        return ok(this.status());
      case "sources.list":
        return this.sources();
      case "record.start":
        return this.start(body);
      case "record.pause":
        return this.pause(body);
      case "record.resume":
        return this.resume(body);
      case "record.stop":
        return this.stop(body);
      case "record.cancel":
        return this.cancel(body);
      case "project.open":
        return this.openProject(body);
      case "project.inspect":
        return this.project
          ? ok({
            projectId: this.project.projectId,
            durationMs: this.project.durationMs,
            clips: this.project.video ? [this.project.video] : [],
            zooms: this.project.zooms ?? [],
            cuts: [],
          })
          : fail("NOT_READY", "No recorder project is open.");
      case "edit.apply":
        return this.applyEdit(body);
      case "captions.generate":
        return this.captionsGenerate(body);
      case "export":
        return this.exportProject(body);
      case "handoff.video": {
        const media = this.project?.video ?? this.project?.path;
        return media
          ? ok({ target: "loam-video", path: media })
          : fail("NOT_READY", "Stop a recording before handing it to Loam Video.");
      }
      default:
        return fail("UNKNOWN_CHANNEL", `Rejected recorder channel: ${method}`);
    }
  }

  private status(): Record<string, unknown> {
    return {
      ready: this.caps.distInstalled,
      recording: this.live?.state === "recording" || this.live?.state === "countdown",
      state: this.live?.state ?? "idle",
      ...(this.project ? { project: this.project.projectId } : {}),
      helper: this.caps.helperOk ? "ok" : "missing",
      compositor: this.caps.compositorOk ? "ok" : "missing",
      capture: this.captureFactory?.kind === "helper" ? "helper" : this.captureFactory ? "ffmpeg" : this.caps.helperOk ? "helper" : "missing",
    };
  }

  private sources(): RecorderCallResult {
    if (this.captureFactory) {
      return ok([{ id: "desktop", kind: "screen", name: "Desktop" }]);
    }
    return this.caps.helperOk
      ? ok([])
      : fail("HELPER_MISSING", "The capture helper is not installed.");
  }

  private rememberWorkspace(value: unknown): void {
    if (typeof value !== "string" || !value.trim()) return;
    try {
      recordingDir(value);
    } catch {
      return;
    }
    this.requestedWorkspace = value.trim();
  }

  private rememberRequest(body: Record<string, unknown>): void {
    this.rememberWorkspace(body.workspace);
    if (typeof body.taskId === "string" && body.taskId.trim()) this.requestedTaskId = body.taskId.trim();
  }

  private async start(body: Record<string, unknown>): Promise<RecorderCallResult> {
    const token = typeof body.consentToken === "string" ? body.consentToken : "";
    const grant = token ? this.grants.get(token) : undefined;
    if (!grant || grant.used || grant.expiresAt <= this.now()) {
      this.rememberRequest(body);
      return fail("CONSENT_REQUIRED", CONSENT_REQUIRED_AR);
    }
    const sourceId = typeof body.sourceId === "string" ? body.sourceId : "";
    if (!sourceId || sourceId !== grant.sourceId) {
      this.rememberRequest(body);
      return fail("CONSENT_REQUIRED", CONSENT_REQUIRED_AR);
    }
    const countdown = body.countdownSec;
    if (countdown !== undefined && (typeof countdown !== "number" || countdown < 0 || countdown > 10)) {
      return fail("BAD_REQUEST", "countdownSec must be between 0 and 10.");
    }
    if (!this.caps.helperOk && !this.captureFactory) return fail("HELPER_MISSING", "The capture helper is not installed.");
    const explicit = typeof body.workspace === "string" && body.workspace.trim() ? body.workspace.trim() : undefined;
    const workspace = explicit ?? this.requestedWorkspace;
    const taskId = typeof body.taskId === "string" && body.taskId.trim() ? body.taskId.trim() : this.requestedTaskId;
    let directory = path.join(os.tmpdir(), "loam-recorder");
    try {
      directory = recordingDir(workspace);
    } catch (error) {
      return fail("BAD_REQUEST", error instanceof Error ? error.message : "Bad recording directory.");
    }
    grant.used = true;
    this.requestedWorkspace = undefined;
    this.requestedTaskId = undefined;
    const id = randomUUID();
    const seconds = typeof countdown === "number" ? countdown : 0;
    this.live = {
      id,
      sourceId,
      state: seconds > 0 ? "countdown" : "recording",
      startedAt: this.now(),
      directory,
      ...(workspace ? { workspace } : {}),
      ...(taskId ? { taskId } : {}),
      cursor: body.cursor !== false,
      systemAudio: grant.systemAudio,
    };
    publish(this.live.state, id, seconds);
    if (this.captureFactory) {
      if (seconds > 0) {
        this.arm = setTimeout(() => {
          this.arm = null;
          if (!this.live) return;
          void this.begin().then((begun) => {
            if (!begun.ok) {
              this.live = null;
              publish("idle");
            }
          });
        }, seconds * 1000);
        this.arm.unref?.();
      } else {
        const begun = await this.begin();
        if (!begun.ok) {
          this.live = null;
          publish("idle");
          return begun;
        }
      }
    }
    return ok({ sessionId: id });
  }

  private async begin(): Promise<RecorderCallResult> {
    if (!this.live || !this.captureFactory) return ok({});
    try {
      this.active = this.captureFactory.start({
        directory: this.live.directory,
        cursor: this.live.cursor,
        systemAudio: this.live.systemAudio,
      });
      await this.active.ready;
      this.live.state = "recording";
      publish("recording", this.live.id);
      return ok({});
    } catch (error) {
      this.active = null;
      return fail("CAPTURE_FAILED", error instanceof Error ? error.message : "Capture failed to start.");
    }
  }

  private async pause(body: Record<string, unknown>): Promise<RecorderCallResult> {
    if (!this.live || this.live.id !== body.sessionId || this.live.state !== "recording") {
      return fail("BAD_SESSION", "That recording session is not in the expected state.");
    }
    await this.active?.pause();
    this.live.state = "paused";
    publish("paused", this.live.id);
    return ok({ state: "paused" });
  }

  private async resume(body: Record<string, unknown>): Promise<RecorderCallResult> {
    if (!this.live || this.live.id !== body.sessionId || this.live.state !== "paused") {
      return fail("BAD_SESSION", "That recording session is not in the expected state.");
    }
    await this.active?.resume();
    this.live.state = "recording";
    publish("recording", this.live.id);
    return ok({ state: "recording" });
  }

  private async stop(body: Record<string, unknown>): Promise<RecorderCallResult> {
    if (!this.live || this.live.id !== body.sessionId) return fail("BAD_SESSION", "Unknown recording session.");
    if (this.live.state === "countdown") return this.cancel(body);
    if (this.live.state !== "recording" && this.live.state !== "paused") {
      return fail("BAD_SESSION", "The recording is not running.");
    }
    if (this.arm) {
      clearTimeout(this.arm);
      this.arm = null;
    }
    this.live.state = "stopping";
    const durationMs = Math.max(0, this.now() - this.live.startedAt);
    const taskId = this.live.taskId;
    const workspace = this.live.workspace;
    const id = this.live.id;
    let projectPath = `recording-${id}.loamrec`;
    let video: string | undefined;
    let audio = false;
    let cursor = false;
    if (this.active) {
      try {
        const done = await this.active.stop();
        video = done.file;
        audio = done.audio === true;
        projectPath = path.join(path.dirname(done.file), `${id}.loamrec`);
        fs.writeFileSync(projectPath, JSON.stringify({
          kind: "loamrec",
          version: 1,
          video: path.basename(done.file),
          durationMs,
        }));
        const visible = publishVisibleRecording(this.live.workspace, done.file, projectPath, durationMs);
        video = visible.video;
        projectPath = visible.project;
        cursor = fs.existsSync(`${video}.cursor.json`);
        if (cursor && this.caps.compositorOk) {
          try {
            const burned = await burnClickZoomExport(video, durationMs, this.zoomExport);
            if (burned) {
              video = burned;
              const saved = JSON.parse(fs.readFileSync(projectPath, "utf8")) as { video?: string };
              saved.video = path.basename(burned);
              fs.writeFileSync(projectPath, JSON.stringify(saved));
            }
          } catch {
            // The raw recording stays when the compositor cannot burn the zoom.
          }
        }
      } catch (error) {
        this.active = null;
        this.live = null;
        publish("idle");
        return fail("CAPTURE_FAILED", error instanceof Error ? error.message : "Capture failed to stop.");
      }
      this.active = null;
    }
    this.project = { projectId: id, durationMs, path: projectPath, ...(video ? { video } : {}) };
    if (video && taskId && workspace) {
      deliverRecording({ taskId, workspace, videoPath: video, bytes: fs.statSync(video).size });
    }
    this.live = null;
    publish("idle");
    return ok({
      project: projectPath,
      durationMs,
      tracks: { video: true, cursor, audio },
    });
  }

  private async cancel(body: Record<string, unknown>): Promise<RecorderCallResult> {
    if (!this.live || this.live.id !== body.sessionId) return fail("BAD_SESSION", "Unknown recording session.");
    if (this.arm) {
      clearTimeout(this.arm);
      this.arm = null;
    }
    await this.active?.discard();
    this.active = null;
    this.live = null;
    publish("idle");
    return ok({ discarded: true });
  }

  private async captionsGenerate(body: Record<string, unknown>): Promise<RecorderCallResult> {
    const lang = body.lang === "ar" || body.lang === "en" ? body.lang : "auto";
    if (this.captions && this.project?.video) {
      try {
        const written = await this.captions.generate(this.project.video, lang);
        return ok({ segments: written.segments, backend: "creative_subtitles", path: written.path });
      } catch (error) {
        const sidecar = this.captionSidecar();
        if (sidecar) return ok({ segments: countCues(sidecar), backend: "sample", path: sidecar });
        return fail("CAPTIONS_MISSING", error instanceof Error ? error.message : "Captions failed.");
      }
    }
    const sidecar = this.captionSidecar();
    if (sidecar) return ok({ segments: countCues(sidecar), backend: "sample", path: sidecar });
    return fail("CAPTIONS_MISSING", "Captions need the local speech server. No whisper model is downloaded.");
  }

  private captionSidecar(): string | null {
    if (this.project?.video) {
      const besideVideo = `${this.project.video}.srt`;
      if (fs.existsSync(besideVideo)) return besideVideo;
    }
    if (this.project?.path) {
      const besideProject = path.join(path.dirname(this.project.path), "desktop.srt");
      if (fs.existsSync(besideProject)) return besideProject;
    }
    return null;
  }

  private async exportProject(body: Record<string, unknown>): Promise<RecorderCallResult> {
    const format = body.format === "gif" || body.format === "webm" || body.format === "mp4" ? body.format : "mp4";
    const resolution = body.resolution === "720p" || body.resolution === "1080p" || body.resolution === "1440p" ? body.resolution : undefined;
    if (this.project?.video && resolution === "1080p" && format === "mp4") {
      const output = path.join(path.dirname(this.project.video), "export-1080p.mp4");
      try {
        const scene = this.project.zooms?.length ? zoomSceneJson(this.project.zooms) : undefined;
        const rendered = await exportCompositor1080(this.project.video, output, this.project.durationMs / 1000, undefined, scene);
        if (rendered) return ok({ path: rendered.path, bytes: rendered.bytes, format, resolution });
      } catch {
        // The addon refused this file. The ffmpeg branch below still writes 1080p.
      }
    }
    if (this.project?.video && this.captureFactory?.transcode && (format !== "mp4" || resolution)) {
      const output = path.join(path.dirname(this.project.video), `export${resolution ? `-${resolution}` : ""}.${format}`);
      try {
        await this.captureFactory.transcode(this.project.video, output, format, resolution);
        return ok({ path: output, bytes: fs.statSync(output).size, format, ...(resolution ? { resolution } : {}) });
      } catch (error) {
        return fail("CAPTURE_FAILED", error instanceof Error ? error.message : "Export failed.");
      }
    }
    if (this.project?.video && format === "mp4") {
      const bytes = fs.statSync(this.project.video).size;
      return ok({ path: this.project.video, bytes, format });
    }
    return fail("NOT_READY", "Stop a recording before exporting it.");
  }

  private async applyEdit(body: Record<string, unknown>): Promise<RecorderCallResult> {
    if (!this.caps.compositorOk || !this.project) {
      return fail("COMPOSITOR_MISSING", "The recorder compositor is not installed, so styled edits cannot run.");
    }
    if (!this.project.video) {
      return fail("NOT_READY", "Stop a recording before applying a zoom.");
    }
    const seconds = Math.max(0.1, this.project.durationMs / 1000);
    const regions = zoomRegionsFromOps(Array.isArray(body.ops) ? body.ops : [], seconds);
    if (regions.length === 0) {
      return fail("BAD_REQUEST", "edit.apply needs a zoom op.");
    }
    const output = path.join(path.dirname(this.project.video), "export-zoom.mp4");
    try {
      const rendered = await exportCompositor1080(this.project.video, output, seconds, undefined, zoomSceneJson(regions));
      if (!rendered) return fail("COMPOSITOR_MISSING", "The recorder compositor is not installed, so styled edits cannot run.");
      this.project.video = rendered.path;
      this.project.zooms = regions;
      return ok({ applied: regions.length, path: rendered.path, bytes: rendered.bytes });
    } catch (error) {
      return fail("CAPTURE_FAILED", error instanceof Error ? error.message : "Zoom export failed.");
    }
  }

  private openProject(body: Record<string, unknown>): RecorderCallResult {
    if (!this.caps.distInstalled) return fail("NOT_INSTALLED", "Loam Recorder is not installed.");
    const sample = body.sample === true
      ? assetUnder(ROOT, "resources", "recorder", "sample", "desktop.loamrec")
      : "";
    const opened = sample || (typeof body.path === "string" && body.path.trim() ? body.path.trim() : "");
    if (!opened) return fail("BAD_REQUEST", "project.open needs a path.");
    if (!fs.existsSync(opened)) return fail("NOT_READY", "That recorder project is not on disk.");
    let durationMs = 0;
    let video: string | undefined;
    if (opened.toLowerCase().endsWith(".loamrec")) {
      try {
        const parsed = JSON.parse(fs.readFileSync(opened, "utf8")) as { durationMs?: unknown; video?: unknown };
        if (typeof parsed.durationMs === "number" && parsed.durationMs >= 0) durationMs = parsed.durationMs;
        if (typeof parsed.video === "string" && parsed.video.trim()) {
          const candidate = path.isAbsolute(parsed.video) ? parsed.video : path.join(path.dirname(opened), parsed.video);
          if (fs.existsSync(candidate)) video = candidate;
        }
      } catch {
        return fail("NOT_READY", "That recorder project could not be read.");
      }
    }
    this.project = { projectId: randomUUID(), durationMs, path: opened, ...(video ? { video } : {}) };
    return ok({ projectId: this.project.projectId, durationMs });
  }
}
