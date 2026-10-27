import type { EvidenceDocument } from "../evidence/types.js";

export interface LegalDocumentChunk {
  index: number;
  total: number;
  start: number;
  end: number;
  pages: number[];
  text: string;
}

export const LEGAL_ANALYSIS_CHUNK_CHARS = 12_000;

export function chunkLegalDocument(document: EvidenceDocument, maxChars = LEGAL_ANALYSIS_CHUNK_CHARS): LegalDocumentChunk[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1000) throw new Error("invalid legal analysis chunk size");
  const pages = document.pages.length > 0 ? document.pages : [{ page: 1, text: document.text, warnings: [] }];
  const boundaries: Array<{ page: number; start: number; end: number }> = [];
  let cursor = 0;
  for (const page of pages) {
    const start = document.text.indexOf(page.text, cursor);
    if (start < 0) throw new Error(`document ${document.id} page positions are inconsistent`);
    boundaries.push({ page: page.page, start, end: start + page.text.length });
    cursor = start + page.text.length;
  }
  const chunks: Array<Omit<LegalDocumentChunk, "index" | "total">> = [];
  let start = 0;
  while (start < document.text.length) {
    const limit = Math.min(document.text.length, start + maxChars);
    const pageBreaks = boundaries.filter((boundary) => boundary.end > start && boundary.end <= limit).map((boundary) => boundary.end);
    const paragraphBreak = document.text.lastIndexOf("\n", limit - 1) + 1;
    let end = pageBreaks.at(-1) ?? (paragraphBreak > start ? paragraphBreak : limit);
    if (end <= start) end = limit;
    const pageNumbers = boundaries.filter((boundary) => boundary.start < end && boundary.end > start).map((boundary) => boundary.page);
    chunks.push({ start, end, pages: pageNumbers, text: document.text.slice(start, end) });
    start = end;
  }
  if (chunks.length === 0) chunks.push({ start: 0, end: 0, pages: [1], text: "" });
  return chunks.map((chunk, index) => ({ ...chunk, index: index + 1, total: chunks.length }));
}

export function chunkAnalysisBatches<T>(items: T[], maxChars = LEGAL_ANALYSIS_CHUNK_CHARS): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let chars = 2;
  for (const item of items) {
    const size = JSON.stringify(item).length + 1;
    if (batch.length > 0 && chars + size > maxChars) {
      batches.push(batch);
      batch = [];
      chars = 2;
    }
    batch.push(item);
    chars += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}
