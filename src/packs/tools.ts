import type { Tool } from "../tools/registry.js";
import type { UiAssetGenerator } from "../design/assets.js";
import { createDeckTools } from "./slides/tools.js";
import { createLocalFileTools } from "./localFileTools.js";
import { createVideoPackTools } from "./video/tools.js";
import { createSitePackTools } from "./build/tools.js";
import { createImagePackTools } from "./image/tools.js";
import { createAudioPackTools } from "./audio/tools.js";
import { createMobilePackTools } from "./mobile/tools.js";
import { createGamePackTools } from "./game/tools.js";
import { createDesktopPackTools } from "./desktop/tools.js";

export interface ServicePackToolOptions {
  imageGenerator?: UiAssetGenerator;
}

export function createServicePackTools(options: ServicePackToolOptions = {}): Tool[] {
  return [
    ...createDeckTools({ ...(options.imageGenerator ? { imageGenerator: options.imageGenerator } : {}) }),
    ...createLocalFileTools(),
    ...createVideoPackTools(),
    ...createSitePackTools(),
    ...createImagePackTools({ ...(options.imageGenerator ? { generator: options.imageGenerator } : {}) }),
    ...createAudioPackTools(),
    ...createMobilePackTools(),
    ...createGamePackTools(),
    ...createDesktopPackTools(),
  ];
}
