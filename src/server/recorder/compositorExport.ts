// 1080p export through the vendored OpenScreen compositor addon.
// The addon is napi-stable, so Node can load the same file Electron 44 loads.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { assetUnder, ROOT } from "../../config.js";
import { zoomRegionsFromOps, zoomSceneJson } from "./zoomScene.js";

// The addon path is absolute, so the require base only has to be a real file in both ESM and CJS.
const require = createRequire(process.execPath);

interface ExportAddon {
  exportMulti: (
    clips: Array<{ screenPath: string; webcamPath: string; sourceStartSec: number; sourceEndSec: number; webcamOffsetSec: number; hasAudio: boolean }>,
    outPath: string,
    sceneJson: string | undefined,
    params: { width: number; height: number; fps: number; codec: string; bitrate: number },
  ) => Promise<unknown>;
}

export function compositorNodePath(root: string = ROOT): string | null {
  const candidate = assetUnder(root, "resources", "recorder", "bin", "win32-x64", "compositor_view.node");
  return fs.existsSync(candidate) ? candidate : null;
}

export type ZoomExporter = (
  input: string,
  output: string,
  seconds: number,
  root?: string,
  sceneJson?: string,
) => Promise<{ path: string; bytes: number } | null>;

/** Burns click-follow zoom into a 1080p file beside the recording. Returns null when the compositor is absent. */
export async function burnClickZoomExport(
  video: string,
  durationMs: number,
  zoomExport: ZoomExporter = exportCompositor1080,
): Promise<string | null> {
  if (!fs.existsSync(`${video}.cursor.json`)) return null;
  const seconds = Math.max(0.1, durationMs / 1000);
  const output = path.join(path.dirname(video), "export-zoom.mp4");
  const regions = zoomRegionsFromOps([{ op: "zoom.autoFromClicks" }], seconds);
  const rendered = await zoomExport(video, output, seconds, undefined, zoomSceneJson(regions));
  if (!rendered || !fs.existsSync(rendered.path)) return null;
  return rendered.path;
}

export async function exportCompositor1080(input: string, output: string, seconds: number, root?: string, sceneJson?: string): Promise<{ path: string; bytes: number } | null> {
  const node = compositorNodePath(root ?? ROOT);
  if (!node) return null;
  const addon = require(node) as ExportAddon;
  await addon.exportMulti(
    [{
      screenPath: input,
      webcamPath: "",
      sourceStartSec: 0,
      sourceEndSec: Math.max(0.1, seconds),
      webcamOffsetSec: 0,
      hasAudio: true,
    }],
    output,
    sceneJson,
    { width: 1920, height: 1080, fps: 30, codec: "h264", bitrate: 8_000_000 },
  );
  return { path: output, bytes: fs.statSync(output).size };
}
