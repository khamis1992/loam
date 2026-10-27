import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rootAsset } from "../../config.js";

export type PdfPageRasterizer = (absPath: string, pageNumber: number) => Promise<Buffer>;

const assetUrl = (...parts: string[]): string => `${path.join(...parts).replaceAll("\\", "/")}/`;

export async function rasterizePdfPage(absPath: string, pageNumber: number, scale = 2): Promise<Buffer> {
  const data = new Uint8Array(fs.readFileSync(absPath));
  const { createCanvas, DOMMatrix, ImageData, Path2D } = await import(pathToFileURL(rootAsset("node_modules", "@napi-rs", "canvas", "index.js")).href);
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
  const { getDocument } = await import(pathToFileURL(rootAsset("node_modules", "pdfjs-dist", "legacy", "build", "pdf.mjs")).href);
  const document = await getDocument({
    data, disableAutoFetch: true, disableStream: true, isEvalSupported: false,
    standardFontDataUrl: assetUrl(rootAsset("node_modules", "pdfjs-dist", "standard_fonts")),
    cMapUrl: assetUrl(rootAsset("node_modules", "pdfjs-dist", "cmaps")),
    wasmUrl: assetUrl(rootAsset("node_modules", "pdfjs-dist", "wasm")),
  }).promise;
  try {
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
    return canvas.toBuffer("image/png");
  } finally {
    await document.destroy();
  }
}
