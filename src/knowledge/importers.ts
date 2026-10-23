/**
 * Neo N3: content extraction for the Knowledge Garden.
 *
 * Importers turn a source (text, file, URL, image) into plain text that the
 * splitter can chunk. Each importer is independent and reports its provenance
 * plus an optional warning, so an import that had to fall back (for example a
 * PDF whose pages are images and no OCR provider is configured) still lands the
 * seeds it could while telling the user what was skipped.
 *
 * OCR is provider-injected: when no OCR provider is wired, `ocrProvider` is
 * undefined and the importer emits an honest `ocr_skipped` warning instead of
 * failing the whole import.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveRead } from "../policy/paths.js";
import { htmlToText } from "../tools/web.js";
import { extractAnyDocumentText } from "../tools/attachments.js";
import type { KnowledgeProvenance, KnowledgeProvenanceSource } from "./types.js";

export interface OcrProvider {
  /** OCR one image buffer to text. */
  recognize(image: Buffer, mime: string): Promise<string>;
}

export interface ExtractedContent {
  text: string;
  warnings: string[];
}

/** Importable file extensions; anything else is reported, not guessed. */
const SUPPORTED_EXT = new Set([
  ".txt", ".md", ".markdown", ".csv", ".json", ".jsonl", ".tsv", ".log",
  ".yml", ".yaml", ".html", ".htm", ".xml", ".js", ".ts", ".py", ".css", ".sql",
  ".pdf", ".docx", ".xlsx", ".pptx",
]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/** Plain text, used directly as the source body. */
export function fromText(text: string): ExtractedContent {
  const trimmed = text.trim();
  if (!trimmed) return { text: "", warnings: ["empty input: nothing to import"] };
  return { text: trimmed, warnings: [] };
}

/**
 * Read a file. Text/office/pdf go through `extractAnyDocumentText` (the same
 * path the attachment tool uses, so PDFs and Office files behave identically
 * here and in the agent). Images are OCR'd when a provider exists.
 */
export async function fromFile(absPath: string, ocr?: OcrProvider): Promise<ExtractedContent> {
  if (!fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) {
    return { text: "", warnings: [`file not found: ${absPath}`] };
  }
  const ext = path.extname(absPath).toLowerCase();
  const warnings: string[] = [];

  if (IMAGE_EXT.has(ext)) {
    if (!ocr) {
      return { text: "", warnings: [`ocr_skipped: no OCR provider configured for ${path.basename(absPath)}`] };
    }
    try {
      const text = await ocr.recognize(fs.readFileSync(absPath), mimeOf(ext));
      return { text: text.trim(), warnings: text.trim() ? [] : ["ocr returned no text"] };
    } catch (err) {
      return { text: "", warnings: [`ocr failed: ${err instanceof Error ? err.message : String(err)}`] };
    }
  }

  if (!SUPPORTED_EXT.has(ext)) {
    return { text: "", warnings: [`unsupported file type: ${ext}`] };
  }
  try {
    return { text: (await extractAnyDocumentText(absPath)).trim(), warnings };
  } catch (err) {
    return { text: "", warnings: [`extraction failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

/** Fetch a URL and strip it to readable text. */
export async function fromUrl(url: string, fetcher?: typeof fetch, signal?: AbortSignal): Promise<ExtractedContent> {
  if (!/^https?:\/\//i.test(url.trim())) {
    return { text: "", warnings: [`unsupported url (http/https only): ${url}`] };
  }
  const doFetch = fetcher ?? fetch;
  try {
    const res = await doFetch(url, { signal, redirect: "follow" });
    if (!res.ok) return { text: "", warnings: [`url returned HTTP ${res.status}`] };
    const contentType = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    if (contentType.includes("text/html") || /<html[\s>]/i.test(raw)) {
      const text = htmlToText(raw).trim();
      return { text, warnings: text ? [] : ["url page had no readable text"] };
    }
    const text = raw.trim();
    return { text, warnings: text ? [] : ["url returned no content"] };
  } catch (err) {
    return { text: "", warnings: [`url fetch failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

function mimeOf(ext: string): string {
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return "application/octet-stream";
  }
}

/** Resolve a workspace-relative path safely (never escapes the workspace). */
export function resolveImportPath(workspace: string, rel: string): string {
  return resolveRead(workspace, rel, false);
}

/** Provenance for a source, kept small and serializable. */
export function provenanceFor(source: KnowledgeProvenanceSource, ref: string, runId?: string): KnowledgeProvenance {
  return { source, ref, runId };
}
