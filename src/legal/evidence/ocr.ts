import { pathToFileURL } from "node:url";
import { rootAsset } from "../../config.js";
import type { LegalOcrProvider } from "./extract.js";

let workerPromise: Promise<import("tesseract.js").Worker> | undefined;

async function worker(): Promise<import("tesseract.js").Worker> {
  if (!workerPromise) {
    const { createWorker } = await import(pathToFileURL(rootAsset("node_modules", "tesseract.js", "src", "index.js")).href) as typeof import("tesseract.js");
    workerPromise = createWorker(["ara", "eng"], 1, {
      langPath: rootAsset("resources", "legal", "ocr"),
      gzip: false,
      cacheMethod: "none",
    });
  }
  return workerPromise;
}

export const localLegalOcr: LegalOcrProvider = {
  async recognize(image) {
    const instance = await worker();
    const result = await instance.recognize(image);
    return { text: result.data.text, confidence: result.data.confidence };
  },
};

export async function closeLegalOcr(): Promise<void> {
  if (!workerPromise) return;
  const instance = await workerPromise;
  workerPromise = undefined;
  await instance.terminate();
}
