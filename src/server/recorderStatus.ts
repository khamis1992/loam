// Availability of the vendored Loam Recorder dist and its native helpers.
// Nothing here downloads or spawns a capture process.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";
import { ffmpegAvailable } from "./workspace/videoRender.js";

export interface RecorderStatus {
  app: "recordercraft";
  name: "Loam Recorder";
  installed: boolean;
  rev: string | null;
  helper: "ok" | "missing";
  compositor: "ok" | "missing";
  capture: "helper" | "ffmpeg" | "missing";
}

export function recorderDistDir(root: string): string {
  return path.join(root, "electron", "recorder", "dist");
}

export function readRecorderStatus(root: string = ROOT): RecorderStatus {
  const dist = recorderDistDir(root);
  let rev: string | null = null;
  let installed = false;
  try {
    const vendor = JSON.parse(fs.readFileSync(path.join(dist, ".vendor.json"), "utf8")) as { rev?: unknown };
    installed = fs.existsSync(path.join(dist, "index.html"));
    rev = installed && typeof vendor.rev === "string" ? vendor.rev : null;
  } catch {
    installed = false;
  }
  const bin = path.join(root, "resources", "recorder", "bin", "win32-x64");
  const helper = fs.existsSync(path.join(bin, "wgc-capture.exe")) ? "ok" : "missing";
  const compositor = fs.existsSync(path.join(root, "electron", "recorder", "compositor.node"))
    || fs.existsSync(path.join(bin, "compositor.node"))
    ? "ok"
    : "missing";
  const capture = ffmpegAvailable() ? "ffmpeg" : helper === "ok" ? "helper" : "missing";
  return { app: "recordercraft", name: "Loam Recorder", installed, rev, helper, compositor, capture };
}
