import type { PackId } from "./types.js";

export function visiblePackAttachment(packId: PackId, path: string, finalPaths: ReadonlySet<string>): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (finalPaths.has(normalized)) return true;
  if (packId === "loam-slides") return normalized === "previews/slide-1.png";
  if (packId === "loam-video") return normalized === "previews/presentation-video.png";
  if (packId === "loam-build") return normalized === "desktop.png" || normalized === "mobile.png";
  return false;
}
