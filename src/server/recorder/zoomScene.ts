// Zoom ops become the scene JSON the compositor already renders.
// focusMode "auto" follows the cursor sidecar beside the recording.

export interface ZoomRegion {
  clipIndex: number;
  startSec: number;
  endSec: number;
  scale: number;
  focusX: number;
  focusY: number;
  focusMode: "auto" | "manual";
  rotation: null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function zoomRegionsFromOps(ops: unknown[], seconds: number): ZoomRegion[] {
  const span = Math.max(0.1, seconds);
  const regions: ZoomRegion[] = [];
  for (const item of ops) {
    if (!item || typeof item !== "object") continue;
    const op = item as { op?: unknown; startSec?: unknown; endSec?: unknown; scale?: unknown; focusX?: unknown; focusY?: unknown };
    const name = String(op.op ?? "");
    if (name === "zoom.autoFromClicks") {
      regions.push({
        clipIndex: 0,
        startSec: 0,
        endSec: span,
        scale: 2,
        focusX: 0.5,
        focusY: 0.5,
        focusMode: "auto",
        rotation: null,
      });
    } else if (name === "zoom.add") {
      const start = Math.max(0, numberOr(op.startSec, 0));
      const end = Math.min(span, Math.max(start + 0.1, numberOr(op.endSec, span)));
      regions.push({
        clipIndex: 0,
        startSec: start,
        endSec: end,
        scale: Math.min(4, Math.max(1.1, numberOr(op.scale, 2))),
        focusX: Math.min(1, Math.max(0, numberOr(op.focusX, 0.5))),
        focusY: Math.min(1, Math.max(0, numberOr(op.focusY, 0.5))),
        focusMode: "manual",
        rotation: null,
      });
    }
  }
  return regions;
}

export function zoomSceneJson(regions: ZoomRegion[]): string {
  return JSON.stringify({
    clips: [],
    layout: {
      preset: "no-webcam",
      webcamSize: 1,
      webcamShape: "rectangle",
      webcamMirror: false,
      webcamPosition: null,
      webcamReactiveZoom: false,
    },
    effects: { padding: 0, blur: false, shadow: 0, roundnessFrac: 0, motionBlur: 0 },
    background: { kind: "color", color: "#000000" },
    zoomRegions: regions,
    cursor: { show: true, size: 1, smoothing: 0, motionBlur: 0, clickBounce: 0, clipToBounds: false, theme: "default" },
    cropByClip: [],
    output: { width: 1920, height: 1080, fps: 30 },
  });
}
