// Loam Recorder session. The agent and the Workspace iframe share this
// contract. Recording cannot start without a single-use consent token.
// A capture factory (ffmpeg) may record when the Windows helper is absent.
// With neither, start reports HELPER_MISSING and does not invent a file.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CaptureFactory } from "./ffmpegCapture.js";

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
  cursor: boolean;
  projectPath?: string;
  durationMs?: number;
}

interface OpenProject {
  projectId: string;
  durationMs: number;
  path?: string;
  video?: string;
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

function fail(code: string, message: string): RecorderCallResult {
  return { ok: false, error: { code, message, retrySafe: false } };
}

function ok(result: unknown): RecorderCallResult {
  return { ok: true, result };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class RecorderSession {
  private readonly grants = new Map<string, ConsentGrant>();
  private live: LiveSession | null = null;
  private project: OpenProject | null = null;
  private arm: ReturnType<typeof setTimeout> | null = null;
  private active: ReturnType<CaptureFactory["start"]> | null = null;

  constructor(
    private readonly caps: RecorderCapabilities,
    private readonly now: () => number = Date.now,
    private readonly captureFactory: CaptureFactory | null = null,
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
          ? ok({ projectId: this.project.projectId, durationMs: this.project.durationMs, clips: [], zooms: [], cuts: [] })
          : fail("NOT_READY", "No recorder project is open.");
      case "edit.apply":
        return this.caps.compositorOk && this.project
          ? ok({ applied: Array.isArray(body.ops) ? body.ops.length : 0, inspect: { projectId: this.project.projectId } })
          : fail("COMPOSITOR_MISSING", "The recorder compositor is not installed, so styled edits cannot run.");
      case "captions.generate":
        return this.caps.captionsBackend === "creative_subtitles"
          ? ok({ segments: 0, backend: "creative_subtitles" })
          : fail("CAPTIONS_MISSING", "Captions need creative_subtitles or the optional whisper pack.");
      case "export":
        return this.exportProject(body);
      case "handoff.video":
        return this.project?.path
          ? ok({ target: "loam-video", path: this.project.path })
          : fail("NOT_READY", "Stop a recording before handing it to Loam Video.");
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
      capture: this.captureFactory ? "ffmpeg" : this.caps.helperOk ? "helper" : "missing",
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

  private start(body: Record<string, unknown>): RecorderCallResult {
    const token = typeof body.consentToken === "string" ? body.consentToken : "";
    const grant = token ? this.grants.get(token) : undefined;
    if (!grant || grant.used || grant.expiresAt <= this.now()) {
      return fail("CONSENT_REQUIRED", CONSENT_REQUIRED_AR);
    }
    const sourceId = typeof body.sourceId === "string" ? body.sourceId : "";
    if (!sourceId || sourceId !== grant.sourceId) return fail("CONSENT_REQUIRED", CONSENT_REQUIRED_AR);
    const countdown = body.countdownSec;
    if (countdown !== undefined && (typeof countdown !== "number" || countdown < 0 || countdown > 10)) {
      return fail("BAD_REQUEST", "countdownSec must be between 0 and 10.");
    }
    if (!this.caps.helperOk && !this.captureFactory) return fail("HELPER_MISSING", "The capture helper is not installed.");
    let directory = path.join(os.tmpdir(), "loam-recorder");
    try {
      directory = recordingDir(body.workspace);
    } catch (error) {
      return fail("BAD_REQUEST", error instanceof Error ? error.message : "Bad recording directory.");
    }
    grant.used = true;
    const id = randomUUID();
    const seconds = typeof countdown === "number" ? countdown : 0;
    this.live = {
      id,
      sourceId,
      state: seconds > 0 ? "countdown" : "recording",
      startedAt: this.now(),
      directory,
      cursor: body.cursor !== false,
    };
    publish(this.live.state, id, seconds);
    if (this.captureFactory) {
      if (seconds > 0) {
        this.arm = setTimeout(() => {
          this.arm = null;
          if (!this.live) return;
          const begun = this.begin();
          if (!begun.ok) {
            this.live = null;
            publish("idle");
          }
        }, seconds * 1000);
        this.arm.unref?.();
      } else {
        const begun = this.begin();
        if (!begun.ok) {
          this.live = null;
          publish("idle");
          return begun;
        }
      }
    }
    return ok({ sessionId: id });
  }

  private begin(): RecorderCallResult {
    if (!this.live || !this.captureFactory) return ok({});
    try {
      this.active = this.captureFactory.start({ directory: this.live.directory, cursor: this.live.cursor });
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
    const id = this.live.id;
    let projectPath = `recording-${id}.loamrec`;
    let video: string | undefined;
    if (this.active) {
      try {
        const done = await this.active.stop();
        video = done.file;
        projectPath = path.join(path.dirname(done.file), `${id}.loamrec`);
        fs.writeFileSync(projectPath, JSON.stringify({
          kind: "loamrec",
          version: 1,
          video: path.basename(done.file),
          durationMs,
        }));
      } catch (error) {
        this.active = null;
        this.live = null;
        publish("idle");
        return fail("CAPTURE_FAILED", error instanceof Error ? error.message : "Capture failed to stop.");
      }
      this.active = null;
    }
    this.project = { projectId: id, durationMs, path: projectPath, ...(video ? { video } : {}) };
    this.live = null;
    publish("idle");
    return ok({
      project: projectPath,
      durationMs,
      tracks: { video: true, cursor: true, audio: false },
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

  private async exportProject(body: Record<string, unknown>): Promise<RecorderCallResult> {
    const format = body.format === "gif" || body.format === "webm" || body.format === "mp4" ? body.format : "mp4";
    if (this.project?.video && format === "mp4") {
      const bytes = fs.statSync(this.project.video).size;
      return ok({ path: this.project.video, bytes, format });
    }
    if (this.project?.video && this.captureFactory?.transcode && (format === "gif" || format === "webm")) {
      const output = path.join(path.dirname(this.project.video), `export.${format}`);
      try {
        await this.captureFactory.transcode(this.project.video, output, format);
        return ok({ path: output, bytes: fs.statSync(output).size, format });
      } catch (error) {
        return fail("CAPTURE_FAILED", error instanceof Error ? error.message : "Export failed.");
      }
    }
    return this.caps.compositorOk && this.project
      ? ok({ path: this.project.path ?? "", bytes: 0, format })
      : fail("COMPOSITOR_MISSING", "Export needs the recorder compositor.");
  }

  private openProject(body: Record<string, unknown>): RecorderCallResult {
    if (!this.caps.distInstalled) return fail("NOT_INSTALLED", "Loam Recorder is not installed.");
    const opened = typeof body.path === "string" && body.path.trim() ? body.path.trim() : "";
    if (!opened) return fail("BAD_REQUEST", "project.open needs a path.");
    this.project = { projectId: randomUUID(), durationMs: 0, path: opened };
    return ok({ projectId: this.project.projectId, durationMs: 0 });
  }
}
