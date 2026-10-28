import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { extractOfficeText, prepareParser, tidyPdfText } from "../../tools/attachments.js";
import { contractLanguage } from "../contract/clauses.js";
import type { ExtractedDocument, ExtractedPage } from "./types.js";

export interface LegalOcrProvider {
  recognize(image: Buffer, mime: string): Promise<{ text: string; confidence?: number }>;
}

function mimeOf(ext: string): string {
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".md" || ext === ".markdown") return "text/markdown";
  return "text/plain";
}

async function pdfPages(abs: string, options: ExtractLegalOptions): Promise<ExtractedPage[]> {
  const { PDFParse } = await prepareParser();
  const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(abs)) });
  try {
    const initial = await parser.getText();
    const total = Math.max(1, initial?.total ?? 1);
    const pages: ExtractedPage[] = [];
    for (let page = 1; page <= total; page++) {
      const getText = parser.getText.bind(parser) as (options?: unknown) => Promise<{ text?: string } | undefined>;
      const result = await getText({ partial: [page] });
      const text = tidyPdfText(String(result?.text ?? ""));
      pages.push({ page, text, warnings: text ? [] : [`page ${page}: no text layer; OCR required`] });
    }
    if (options.ocr && options.rasterize) {
      for (const page of pages) {
        if (page.text.trim()) continue;
        const image = await options.rasterize(abs, page.page);
        const recognized = await options.ocr.recognize(image, "image/png");
        page.text = recognized.text.trim();
        page.confidence = recognized.confidence;
        page.warnings = page.text ? [`page ${page.page}: OCR text requires source review`] : [`page ${page.page}: OCR returned no text`];
      }
    }
    return pages;
  } finally {
    await parser.destroy?.();
  }
}

export interface ExtractLegalOptions {
  ocr?: LegalOcrProvider;
  rasterize?: (absPath: string, pageNumber: number) => Promise<Buffer>;
}

export async function extractLegalDocument(absPath: string, options: ExtractLegalOptions = {}): Promise<ExtractedDocument> {
  const ext = path.extname(absPath).toLowerCase();
  const raw = fs.readFileSync(absPath);
  const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
  const mime = mimeOf(ext);
  const ocr = options.ocr;
  let pages: ExtractedPage[];
  if (ext === ".pdf") {
    pages = await pdfPages(absPath, options);
  } else if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
    if (!ocr) throw new Error("OCR is required for image documents");
    const recognized = await ocr.recognize(raw, mime);
    pages = [{ page: 1, text: recognized.text.trim(), confidence: recognized.confidence, warnings: recognized.text.trim() ? ["OCR text requires source review"] : ["OCR returned no text"] }];
  } else if (ext === ".docx") {
    pages = [{ page: 1, text: extractOfficeText(absPath), warnings: ["DOCX positions are paragraph anchors, not rendered page numbers"] }];
  } else if ([".txt", ".md", ".markdown", ".csv", ".json", ".jsonl", ".tsv", ".log", ".yml", ".yaml", ".html", ".xml"].includes(ext)) {
    pages = [{ page: 1, text: raw.toString("utf8"), warnings: [] }];
  } else {
    throw new Error(`unsupported legal document type: ${ext}`);
  }
  const warnings = pages.flatMap((page) => page.warnings);
  if (pages.some((page) => page.confidence !== undefined && page.confidence < 70)) warnings.push("low OCR confidence; verify every material fact against the source image");
  return {
    fileName: path.basename(absPath), mime, sha256,
    language: contractLanguage(pages.map((page) => page.text).join("\n")),
    text: pages.map((page) => page.text).join("\n\n"), pages, warnings,
  };
}
