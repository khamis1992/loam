import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { SCRIPTS_DIR } from "../config.js";

const UI_SCRIPT = path.join(SCRIPTS_DIR, "win-ui.ps1");

function runPs(args: string[], timeoutMs = 30_000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", UI_SCRIPT, ...args],
      { windowsHide: true, env: { ...process.env } },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, out, err: err + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

export interface CaptureOptions {
  dir: string;
  format?: "png" | "jpg";
  maxWidth?: number;
  quality?: number;
  name?: string;
}

export interface CaptureResult {
  path: string;
  bytes: number;
  width: number;
  height: number;
  mediaType: string;
  base64: string;
  at: string;
}

/** Capture one screen frame.
 *  PowerShell only grabs a plain PNG (kept benign for antivirus); resizing + JPEG encoding
 *  happen here in Node with sharp. */
export async function captureScreen(opts: CaptureOptions): Promise<CaptureResult> {
  if (process.platform !== "win32") throw new Error("screen capture is Windows-only in this build");
  fs.mkdirSync(opts.dir, { recursive: true });
  const format = opts.format ?? "jpg";
  const name = opts.name ?? `screen_${Date.now()}`;
  const tmpPng = path.join(opts.dir, `.${name}.src.png`);
  const res = await runPs(["-Action", "screenshot", "-Out", tmpPng]);
  if (res.code !== 0) throw new Error(`screen capture failed: ${res.err || res.out}`);
  if (!fs.existsSync(tmpPng)) throw new Error(`screen capture produced no file: ${res.out}`);

  const raw = sharp(fs.readFileSync(tmpPng));
  let pipeline = raw;
  if (opts.maxWidth && opts.maxWidth > 0) {
    const meta = await raw.metadata();
    if ((meta.width ?? 0) > opts.maxWidth) pipeline = pipeline.resize({ width: opts.maxWidth });
  }

  const outPath = path.join(opts.dir, `${name}.${format}`);
  if (format === "png") {
    await pipeline.png().toFile(outPath);
  } else {
    await pipeline.jpeg({ quality: opts.quality ?? 60, mozjpeg: false }).toFile(outPath);
  }
  fs.rmSync(tmpPng, { force: true });

  const meta = await sharp(outPath).metadata();
  const buf = fs.readFileSync(outPath);
  return {
    path: outPath,
    bytes: buf.length,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    mediaType: format === "png" ? "image/png" : "image/jpeg",
    base64: buf.toString("base64"),
    at: new Date().toISOString(),
  };
}
