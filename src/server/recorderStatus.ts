// Availability of the vendored Loam Recorder dist and its native helpers.
// Nothing here downloads or spawns a capture process.
import fs from "node:fs";
import path from "node:path";
import { assetUnder, ROOT } from "../config.js";
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
  const bin = assetUnder(root, "resources", "recorder", "bin", "win32-x64");
  const helper = fs.existsSync(path.join(bin, "wgc-capture.exe")) ? "ok" : "missing";
  const compositorNames = ["compositor.node", "compositor_view.node"];
  const compositor = compositorNames.some((name) => fs.existsSync(path.join(root, "electron", "recorder", name)) || fs.existsSync(path.join(bin, name)))
    ? "ok"
    : "missing";
  const capture = helper === "ok" ? "helper" : ffmpegAvailable() ? "ffmpeg" : "missing";
  return { app: "recordercraft", name: "Loam Recorder", installed, rev, helper, compositor, capture };
}
