// Desktop capture through the ffmpeg-static build already shipped with Loam.
// The Windows Graphics Capture helper replaces this when its exe is installed.
// This build has no WASAPI loopback, so system audio is not claimed here.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ffmpegAvailable, ffmpegPath } from "../workspace/videoRender.js";

export interface ActiveCapture {
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<{ file: string }>;
  discard(): Promise<void>;
}

export interface CaptureFactory {
  start(input: { directory: string; cursor: boolean }): ActiveCapture;
  transcode?(input: string, output: string, format: "gif" | "webm"): Promise<void>;
}

export function desktopGrabArgs(file: string, cursor: boolean): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "gdigrab", "-framerate", "30",
    "-draw_mouse", cursor ? "1" : "0",
    "-i", "desktop",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    file,
  ];
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code ?? "signal"}`));
    });
  });
}

function waitForQuit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
    }, 4_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function closeGrab(child: ChildProcess): Promise<void> {
  try { child.stdin?.write("q"); } catch { child.kill(); }
  await waitForQuit(child);
}

export function createFfmpegCapture(): CaptureFactory | null {
  if (process.platform !== "win32" || !ffmpegAvailable()) return null;
  return {
    start(input) {
      fs.mkdirSync(input.directory, { recursive: true });
      const segments: string[] = [];
      let child: ChildProcess | null = null;
      let index = 0;
      const open = () => {
        const file = path.join(input.directory, `segment-${index}.mp4`);
        index += 1;
        segments.push(file);
        child = spawn(ffmpegPath(), desktopGrabArgs(file, input.cursor), {
          windowsHide: true,
          stdio: ["pipe", "ignore", "pipe"],
        });
      };
      open();
      return {
        async pause() {
          if (!child) return;
          const current = child;
          child = null;
          await closeGrab(current);
        },
        async resume() {
          if (!child) open();
        },
        async discard() {
          if (child) {
            const current = child;
            child = null;
            current.kill();
            await waitForQuit(current);
          }
          for (const file of segments) fs.rmSync(file, { force: true });
          fs.rmSync(path.join(input.directory, "recording.mp4"), { force: true });
        },
        async stop() {
          if (child) {
            const current = child;
            child = null;
            await closeGrab(current);
          }
          const finalFile = path.join(input.directory, "recording.mp4");
          const ready = segments.filter((file) => fs.existsSync(file) && fs.statSync(file).size > 0);
          if (ready.length === 0) throw new Error("The capture file is empty.");
          if (ready.length === 1) {
            if (fs.existsSync(finalFile)) fs.rmSync(finalFile);
            fs.renameSync(ready[0]!, finalFile);
          } else {
            const list = path.join(input.directory, "segments.txt");
            const body = ready
              .map((file) => `file '${file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
              .join("\n");
            fs.writeFileSync(list, body);
            await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", finalFile]);
            fs.rmSync(list, { force: true });
            for (const file of ready) fs.rmSync(file, { force: true });
          }
          return { file: finalFile };
        },
      };
    },
    async transcode(input, output, format) {
      const args = format === "gif"
        ? ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vf", "fps=12,scale=720:-1", output]
        : ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-c:v", "libvpx-vp9", "-crf", "36", "-b:v", "0", output];
      await runFfmpeg(args);
    },
  };
}
