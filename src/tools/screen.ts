import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { Config } from "../config.js";
import { captureScreen, type CaptureResult } from "../screen/capture.js";
import type { LiveFrame, ScreenLive } from "../screen/live.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";

/** Coarse 16x16 grayscale signature used to detect on-screen change. */
async function signature(file: string): Promise<Buffer> {
  return sharp(file).resize(16, 16, { fit: "fill" }).grayscale().raw().toBuffer();
}

function diffPercent(a: Buffer, b: Buffer): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return (sum / (a.length * 255)) * 100;
}

/** Screen tools: let the agent see the live desktop (and optionally attach the frame for vision models). */
export function createScreenTools(live: ScreenLive, cfg: Config): Tool[] {
  const shotDir = () => path.join(cfg.workspace, ".screenshots");

  return [
    {
      name: "screen_look",
      description:
        "Look at the current screen. Returns the saved image path plus (when vision is enabled) the image itself so you can see it. By default it reuses the live frame if streaming is active.",
      parameters: {
        type: "object",
        properties: {
          fresh: { type: "boolean", description: "Force a new capture instead of using the live frame." },
          maxWidth: { type: "number", description: "Downscale width cap (default from config)." },
          format: { type: "string", enum: ["jpg", "png"] },
        },
      },
      async run(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
        const wantFresh = args["fresh"] === true;
        const cached = live.latest();
        try {
          let frame: CaptureResult | LiveFrame | null = wantFresh ? null : cached;
          if (!frame) {
            frame = await captureScreen({
              dir: shotDir(),
              format: str(args, "format", "jpg") === "png" ? "png" : "jpg",
              quality: cfg.screen.quality,
              maxWidth: num(args, "maxWidth", cfg.screen.maxWidth),
              name: `look_${Date.now()}`,
            });
          }
          const source = wantFresh || !cached ? "captured" : "live-frame";
          const text = [
            `screen ${frame.width}x${frame.height} (${frame.bytes} bytes, ${source})`,
            `path: ${frame.path}`,
            cfg.vision.enabled ? "image attached for vision models" : "(vision disabled: use computer_ui_tree / computer_ui_list to read the UI instead)",
          ].join("\n");
          return { ok: true, content: text, images: cfg.vision.enabled ? [frame.base64] : undefined };
        } catch (err) {
          return { ok: false, content: `screen_look failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "screen_stream_start",
      description: "Start live screen streaming (frames broadcast to /screen.html and cached for screen_look).",
      parameters: { type: "object", properties: { fps: { type: "number", description: "Frames per second (0.2-10, default from config)." } } },
      async run(args: Record<string, unknown>): Promise<ToolResult> {
        if (!cfg.screen.enabled) return { ok: false, content: "screen streaming is disabled in config" };
        live.start(num(args, "fps", cfg.screen.fps));
        return { ok: true, content: JSON.stringify(live.status()) };
      },
    },
    {
      name: "screen_stream_status",
      description: "Report live screen streaming status (running, fps, frames, subscribers, size).",
      parameters: { type: "object", properties: {} },
      async run(): Promise<ToolResult> {
        return { ok: true, content: JSON.stringify(live.status()) };
      },
    },
    {
      name: "screen_stream_stop",
      description: "Stop live screen streaming.",
      parameters: { type: "object", properties: {} },
      async run(): Promise<ToolResult> {
        live.stop();
        return { ok: true, content: JSON.stringify(live.status()) };
      },
    },
    {
      name: "screen_watch",
      description:
        "Watch the screen live for a period: captures a frame every intervalMs for `seconds`, measures how much the screen changes, and returns a summary plus the most-changed frame (attached for vision). Use this to MONITOR a running process (install, render, build, game) instead of a single screenshot.",
      parameters: {
        type: "object",
        properties: {
          seconds: { type: "number", description: "How long to watch (default 8, max 60)." },
          intervalMs: { type: "number", description: "Gap between frames (default 1000, min 300)." },
          attach: { type: "string", enum: ["changed", "last", "none"], description: "Which frame to attach (default: changed)." },
        },
      },
      async run(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
        const seconds = Math.min(Math.max(num(args, "seconds", 8), 1), 60);
        const intervalMs = Math.min(Math.max(num(args, "intervalMs", 1000), 300), 10000);
        const attach = str(args, "attach", "changed");
        const dir = shotDir();
        const started = Date.now();
        const frames: Array<{ at: number; bytes: number; sig: Buffer; path: string }> = [];
        try {
          while (Date.now() - started < seconds * 1000) {
            const frame = await captureScreen({
              dir,
              format: "jpg",
              quality: cfg.screen.quality,
              maxWidth: cfg.screen.maxWidth,
              name: `watch_${Date.now()}`,
            });
            frames.push({ at: Date.now() - started, bytes: frame.bytes, sig: await signature(frame.path), path: frame.path });
            await new Promise((r) => setTimeout(r, intervalMs));
            if (frames.length >= 40) break;
          }
          if (frames.length === 0) return { ok: false, content: "screen_watch: no frames captured" };
          let maxDiff = 0;
          let maxIdx = 0;
          let totalDiff = 0;
          for (let i = 1; i < frames.length; i++) {
            const d = diffPercent(frames[i - 1]!.sig, frames[i]!.sig);
            totalDiff += d;
            if (d > maxDiff) {
              maxDiff = d;
              maxIdx = i;
            }
          }
          const avg = frames.length > 1 ? totalDiff / (frames.length - 1) : 0;
          const changedIdx = maxDiff >= 1 ? maxIdx : frames.length - 1;
          const pick = attach === "last" ? frames.length - 1 : changedIdx;
          const chosen = frames[pick]!;
          const lines = [
            `watched ${(seconds).toFixed(0)}s · ${frames.length} frames @ ${intervalMs}ms`,
            `average change between frames: ${avg.toFixed(2)}%`,
            `largest change: ${maxDiff.toFixed(2)}% at ${(maxDiff >= 1 ? chosen.at : frames[frames.length - 1]!.at) / 1000}s`,
            maxDiff < 0.5 ? "the screen looks static — likely waiting for input or finished" : "the screen is changing — activity detected",
            `attached frame: ${path.basename(chosen.path)} (${attach})`,
          ];
          const images =
            attach === "none" || !cfg.vision.enabled
              ? undefined
              : [fs.readFileSync(chosen.path).toString("base64")];
          return { ok: true, content: lines.join("\n"), images };
        } catch (err) {
          return { ok: false, content: `screen_watch failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
  ];
}
