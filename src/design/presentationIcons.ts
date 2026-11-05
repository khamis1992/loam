import fs from "node:fs";
import sharp from "sharp";
import { taskPath } from "../server/taskWorkspace.js";
import type { PresentationImage } from "../agent/presentationPipeline.js";

export const PRESENTATION_ICON_IDS = ["facts", "landmarks", "language", "location"] as const;
export type PresentationIconId = (typeof PRESENTATION_ICON_IDS)[number];

const PATHS: Record<PresentationIconId, string> = {
  facts: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  landmarks: '<path d="M3 21h18M6 21V10M10 21V4M14 21V8M18 21V6"/><circle cx="6" cy="8" r="2"/><circle cx="10" cy="3" r="2"/><circle cx="14" cy="6" r="2"/><circle cx="18" cy="4" r="2"/>',
  language: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 4 6 4 9s-1 6-4 9c-3-3-4-6-4-9s1-6 4-9ZM5.5 6.5c3 2 10 2 13 0M5.5 17.5c3-2 10-2 13 0"/>',
  location: '<path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
};

function svg(id: PresentationIconId, color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><title>${id}</title>${PATHS[id]}</svg>`;
}

export async function createPresentationIcons(taskRoot: string, color: string): Promise<Record<PresentationIconId, PresentationImage>> {
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error("presentation icon color must be #RRGGBB");
  const entries = await Promise.all(PRESENTATION_ICON_IDS.map(async (id) => {
    const file = taskPath(taskRoot, `assets/icons/${id}.png`);
    fs.mkdirSync(taskPath(taskRoot, "assets/icons"), { recursive: true });
    await sharp(Buffer.from(svg(id, color)), { density: 192 }).resize(64, 64).png().toFile(file);
    const image: PresentationImage = {
      path: file,
      name: `${id} outlined icon`,
      alt: id,
      attribution: "Loam original outlined icon",
      source: "local://presentation-icons",
    };
    return [id, image] as const;
  }));
  return Object.fromEntries(entries) as Record<PresentationIconId, PresentationImage>;
}
