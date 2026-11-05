// Windows Graphics Capture helper from the pinned OpenScreen build.
// The helper reads one JSON argument and pause/resume/stop lines on stdin.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assetUnder } from "../../config.js";
import { cursorSamplerPath, startCursorSampler, type CursorSampler } from "./cursorSampler.js";
import { transcodeRecording, type ActiveCapture, type CaptureFactory, type CaptureStart } from "./ffmpegCapture.js";

const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 60_000;

export function wgcHelperPath(root: string): string | null {
  const candidate = assetUnder(root, "resources", "recorder", "bin", "win32-x64", "wgc-capture.exe");
  return fs.existsSync(candidate) ? candidate : null;
}

export function wgcConfig(file: string, input: Pick<CaptureStart, "cursor" | "systemAudio">): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sourceType: "display",
    sourceId: "desktop",
    screenPath: file,
    outputPath: file,
    fps: 30,
    captureSystemAudio: input.systemAudio,
    captureMic: false,
    captureCursor: input.cursor,
    webcamEnabled: false,
    hasDisplayBounds: false,
    preferSoftwareEncoder: false,
  };
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("The capture helper did not exit."));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function createWgcCapture(helperPath: string): CaptureFactory | null {
  if (!fs.existsSync(helperPath)) return null;
  return {
    kind: "helper",
    start(input) {
      fs.mkdirSync(input.directory, { recursive: true });
      const file = path.join(input.directory, "recording.mp4");
      const samplerExe = input.cursor ? cursorSamplerPath(helperPath) : null;
      const sampler: CursorSampler | null = samplerExe ? startCursorSampler(samplerExe, `${file}.cursor.json`) : null;
      let output = "";
      const child = spawn(helperPath, [JSON.stringify(wgcConfig(file, input))], {
        cwd: input.directory,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const take = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.length > 64_000) output = output.slice(-32_000);
      };
      child.stdout?.on("data", take);
      child.stderr?.on("data", take);
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The capture helper did not start.")), START_TIMEOUT_MS);
        const started = () => {
          if (!output.includes("Recording started")) return;
          clearTimeout(timer);
          resolve();
        };
        child.stdout?.on("data", started);
        child.stderr?.on("data", started);
        child.once("exit", (code) => {
          if (output.includes("Recording started")) return;
          clearTimeout(timer);
          reject(new Error(`The capture helper exited ${code ?? "signal"} before recording started.`));
        });
      });
      const capture: ActiveCapture = {
        ready,
        async pause() { child.stdin?.write("pause\n"); },
        async resume() { child.stdin?.write("resume\n"); },
        async discard() {
          sampler?.discard();
          child.kill();
          await waitForExit(child, 5_000).catch(() => undefined);
          fs.rmSync(file, { force: true });
          fs.rmSync(`${file}.cursor.json`, { force: true });
        },
        async stop() {
          await ready;
          try { child.stdin?.write("stop\n"); child.stdin?.end(); } catch { child.kill(); }
          await waitForExit(child, STOP_TIMEOUT_MS);
          const track = await sampler?.finish();
          if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
            throw new Error(output.trim().slice(-400) || "The capture helper wrote an empty file.");
          }
          const audio = input.systemAudio && !/system audio.*(fail|unavailable)/i.test(output);
          return { file, audio, ...(track?.path ? { cursor: true } : {}) };
        },
      };
      return capture;
    },
    transcode: transcodeRecording,
  };
}
