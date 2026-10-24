import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { ROOT } from "../config.js";
import { resolveRead } from "../policy/paths.js";
import { normalizeText } from "../knowledge/text.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";

const WORKER_FILE = path.join(ROOT, "dist", "pdf.worker.mjs");

/** pdf-parse v2 relies on browser DOM globals; supply minimal stubs in Node. */
function ensurePdfPolyfills(): void {
  const g = globalThis as Record<string, unknown>;
  g.DOMMatrix ??= class {};
  g.DOMPoint ??= class {};
  g.Path2D ??= class {};
  g.Image ??= class {};
}

export function prepareParser(): Promise<{ PDFParse: (new (opts: { data?: Uint8Array }) => {
  getText(): Promise<{ text?: string; total?: number } | undefined>;
  destroy(): Promise<void> | void;
}) }> {
  ensurePdfPolyfills();
  return (async () => {
    const mod = (await import("pdf-parse")) as unknown as {
      PDFParse: (new (opts: { data?: Uint8Array }) => {
        getText(): Promise<{ text?: string; total?: number } | undefined>;
        destroy(): Promise<void> | void;
      }) & { setWorker?: (src?: string) => string };
    };
    try {
      if (fs.existsSync(WORKER_FILE)) mod.PDFParse.setWorker?.(pathToFileURL(WORKER_FILE).href);
      else mod.PDFParse.setWorker?.();
    } catch {
      /* fall back to pdfjs's inline "fake worker" */
    }
    return mod;
  })();
}

/**
 * N21: tidy pdf-parse output before it is stored or split.
 *
 * pdf-parse paints each page, then appends a page footer (`-- 1 of 1 --`) and
 * separator rules. Those are page furniture, not document text: left in place
 * they would surface inside a seed's body and pollute retrieval. They are
 * stripped here, and the remaining text is normalized with the same
 * `normalizeText` the Knowledge Garden uses, so an Arabic PDF is stored in the
 * folded form a query will be written in (ta marbuta to ha, diacritics and
 * tatweel dropped) and the two sides agree.
 */
export function tidyPdfText(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter((line) => !/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/.test(line))
    .filter((line) => !/^\s*-{3,}\s*$/.test(line))
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function pdfText(abs: string): Promise<string> {
  const mod = await prepareParser();
  const parser = new mod.PDFParse({ data: new Uint8Array(fs.readFileSync(abs)) });
  try {
    const result = await parser.getText();
    return normalizeText(tidyPdfText(String(result?.text ?? "")));
  } finally {
    try { await parser.destroy?.(); } catch { /* ignore */ }
  }
}

/** Pure-Node ZIP Central Directory reader (supports method 0 stored & 8 deflate). */
function readZipEntries(buf: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ملف الأرشيف تالف أو ليس بصيغة ZIP/Office صالحة");
  const count = buf.readUInt16LE(eocd + 10);
  let cdPos = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count && cdPos + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(cdPos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(cdPos + 10);
    const compSize = buf.readUInt32LE(cdPos + 20);
    const nameLen = buf.readUInt16LE(cdPos + 28);
    const extraLen = buf.readUInt16LE(cdPos + 30);
    const commentLen = buf.readUInt16LE(cdPos + 32);
    const localOffset = buf.readUInt32LE(cdPos + 42);
    const name = buf.subarray(cdPos + 46, cdPos + 46 + nameLen).toString("utf8");
    cdPos += 46 + nameLen + extraLen + commentLen;

    if (localOffset + 30 > buf.length) continue;
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) continue;
    const slice = buf.subarray(dataStart, dataStart + compSize);
    try {
      if (method === 0) entries.set(name, Buffer.from(slice));
      else if (method === 8) entries.set(name, zlib.inflateRawSync(slice));
    } catch {
      /* skip corrupt entry */
    }
  }
  return entries;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Extract readable text from .docx, .xlsx, .pptx (OOXML ZIP packages). */
export function extractOfficeText(abs: string): string {
  const ext = path.extname(abs).toLowerCase();
  const entries = readZipEntries(fs.readFileSync(abs));

  if (ext === ".docx") {
    const doc = entries.get("word/document.xml");
    if (!doc) throw new Error("word/document.xml غير موجود داخل ملف docx");
    const xml = doc.toString("utf8");
    const text = xml
      .replace(/<w:tab\b[^>]*\/>/g, "\t")
      .replace(/<w:(?:br|cr)\b[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tr>/g, "\n")
      .replace(/<\/w:tc>/g, "\t")
      .replace(/<[^>]+>/g, "");
    return decodeXmlEntities(text).replace(/\n{3,}/g, "\n\n").trim();
  }

  if (ext === ".pptx") {
    const slides = [...entries.keys()]
      .filter((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
      .sort((a, b) => {
        const na = Number(/(\d+)/.exec(a)?.[1] ?? 0);
        const nb = Number(/(\d+)/.exec(b)?.[1] ?? 0);
        return na - nb;
      });
    const out: string[] = [];
    for (let i = 0; i < slides.length; i++) {
      const xml = entries.get(slides[i]!)!.toString("utf8");
      const text = decodeXmlEntities(
        xml
          .replace(/<\/a:p>/g, "\n")
          .replace(/<a:br\b[^>]*\/>/g, "\n")
          .replace(/<[^>]+>/g, ""),
      )
        .replace(/\n{3,}/g, "\n")
        .trim();
      if (text) out.push(`--- شريحة ${i + 1} ---\n${text}`);
    }
    return out.join("\n\n").trim();
  }

  if (ext === ".xlsx") {
    const shared: string[] = [];
    const ss = entries.get("xl/sharedStrings.xml");
    if (ss) {
      const ssXml = ss.toString("utf8");
      for (const m of ssXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
        const inner = m[1] ?? "";
        const parts: string[] = [];
        for (const tm of inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
          parts.push(decodeXmlEntities(tm[1] ?? ""));
        }
        shared.push(parts.join(""));
      }
    }
    const sheets = [...entries.keys()]
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))
      .sort((a, b) => {
        const na = Number(/(\d+)/.exec(a)?.[1] ?? 0);
        const nb = Number(/(\d+)/.exec(b)?.[1] ?? 0);
        return na - nb;
      });
    const out: string[] = [];
    for (let i = 0; i < sheets.length; i++) {
      const xml = entries.get(sheets[i]!)!.toString("utf8");
      const rows: string[] = [];
      for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells: string[] = [];
        for (const cm of (rm[1] ?? "").matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
          const attrs = cm[1] ?? "";
          const body = cm[2] ?? "";
          const tAttr = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "";
          if (tAttr === "inlineStr") {
            const inline = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => decodeXmlEntities(x[1] ?? "")).join("");
            cells.push(inline);
          } else {
            const val = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
            if (tAttr === "s") {
              const idx = parseInt(val, 10);
              cells.push(Number.isFinite(idx) && shared[idx] !== undefined ? shared[idx]! : val);
            } else {
              cells.push(decodeXmlEntities(val));
            }
          }
        }
        if (cells.some((c) => c.trim().length > 0)) rows.push(cells.join("\t"));
      }
      if (rows.length > 0) out.push(`--- ورقة ${i + 1} ---\n${rows.join("\n")}`);
    }
    return out.join("\n\n").trim();
  }

  throw new Error(`Unsupported office format: ${ext}`);
}

function textFile(abs: string): string {
  return fs.readFileSync(abs, "utf8");
}

export const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".jsonl", ".tsv", ".log", ".yml", ".yaml", ".html", ".xml", ".js", ".ts", ".py", ".css", ".sql"]);
export const OFFICE_EXT = new Set([".docx", ".xlsx", ".pptx"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const MAX_CHARS = 120_000;

export async function extractAnyDocumentText(abs: string): Promise<string> {
  const ext = path.extname(abs).toLowerCase();
  if (ext === ".pdf") return pdfText(abs);
  if (OFFICE_EXT.has(ext)) return extractOfficeText(abs);
  if (TEXT_EXT.has(ext)) return textFile(abs);
  throw new Error(`نوع غير مدعوم للاستخراج (${ext}) — استخدم shell_run لمعالجة هذا النوع.`);
}

/** Attachment tools: extract text from documents and attach images for vision. */
export function attachmentTools(): Tool[] {
  return [
    {
      name: "file_extract_text",
      description:
        "Extract readable text from an attached document (PDF, DOCX, XLSX, PPTX, txt, md, csv, json, code). Returns the text plus its path. Use it to analyse an attached file before acting on it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Attachment path relative to the workspace (e.g. uploads/report.pdf or uploads/sheet.xlsx)." },
          maxChars: { type: "number", description: "Cap on returned characters (default 120000)." },
        },
        required: ["path"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        try {
          const abs = resolveRead(ctx.workspace, str(args, "path"), false);
          if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return { ok: false, content: `ليس ملفاً: ${str(args, "path")}` };
          const text = await extractAnyDocumentText(abs);
          const cap = num(args, "maxChars", MAX_CHARS);
          const total = text.length;
          const trimmed = text.slice(0, cap);
          const header = `استخراج نص من "${str(args, "path")}" (${total.toLocaleString()} حرف${total > cap ? ` — عُرض أول ${cap.toLocaleString()}` : ""})\n\n`;
          return { ok: true, content: header + trimmed };
        } catch (err) {
          return { ok: false, content: `file_extract_text failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "file_view_image",
      description:
        "Attach an image file (attachment or screenshot) to the next model call so a vision model can see it. Works like screen_look but for a stored image.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Image path relative to the workspace (e.g. uploads/photo.jpg)." },
          maxWidth: { type: "number", description: "Downscale width cap (default from config)." },
        },
        required: ["path"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        try {
          const abs = resolveRead(ctx.workspace, str(args, "path"), false);
          if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return { ok: false, content: `ليس ملفاً: ${str(args, "path")}` };
          if (!IMAGE_EXT.has(path.extname(abs).toLowerCase())) {
            return { ok: false, content: `ليست صورة مدعومة (${path.extname(abs)}) — استخدم file_extract_text.` };
          }
          const cap = num(args, "maxWidth", 0) || ctx.cfg.screen.maxWidth;
          let img = sharp(fs.readFileSync(abs));
          if (cap > 0) img = img.resize({ width: cap, withoutEnlargement: true });
          const buf = await img.png().toBuffer();
          return {
            ok: true,
            content: `image attached: ${str(args, "path")} (${buf.length} bytes)`,
            images: [buf.toString("base64")],
          };
        } catch (err) {
          return { ok: false, content: `file_view_image failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
  ];
}
