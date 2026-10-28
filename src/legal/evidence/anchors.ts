import crypto from "node:crypto";
import type { EvidenceAnchor, ExtractedDocument } from "./types.js";

export function anchorForRange(documentId: string, text: string, start: number, end: number, page?: number, paragraph?: number): EvidenceAnchor {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) throw new Error("invalid evidence range");
  const quote = text.slice(start, end);
  if (!quote.trim()) throw new Error("evidence quote is empty");
  return { documentId, ...(page !== undefined ? { page } : {}), ...(paragraph !== undefined ? { paragraph } : {}), start, end, quote, sha256: crypto.createHash("sha256").update(quote, "utf8").digest("hex") };
}

export function paragraphAnchors(document: Pick<ExtractedDocument, "text">, documentId: string, page = 1): EvidenceAnchor[] {
  const anchors: EvidenceAnchor[] = [];
  const pattern = /[^\n]+/g;
  let index = 0;
  for (const match of document.text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (match[0].trim()) anchors.push(anchorForRange(documentId, document.text, start, end, page, index));
    index++;
  }
  return anchors;
}

export function documentParagraphAnchors(document: Pick<ExtractedDocument, "text" | "pages">, documentId: string): EvidenceAnchor[] {
  const pages = document.pages.length > 0 ? document.pages : [{ page: 1, text: document.text, warnings: [] }];
  const anchors: EvidenceAnchor[] = [];
  let cursor = 0;
  for (const page of pages) {
    const offset = document.text.indexOf(page.text, cursor);
    if (offset < 0) throw new Error(`document ${documentId} page positions are inconsistent`);
    for (const anchor of paragraphAnchors({ text: page.text }, documentId, page.page)) {
      anchors.push({ ...anchor, start: anchor.start + offset, end: anchor.end + offset });
    }
    cursor = offset + page.text.length;
  }
  return anchors;
}

export function findAnchors(documentId: string, text: string, needle: string, page?: number): EvidenceAnchor[] {
  if (!needle.trim()) return [];
  const anchors: EvidenceAnchor[] = [];
  let from = 0;
  while (from < text.length) {
    const start = text.indexOf(needle, from);
    if (start < 0) break;
    anchors.push(anchorForRange(documentId, text, start, start + needle.length, page));
    from = start + needle.length;
  }
  return anchors;
}

export function validateAnchor(anchor: EvidenceAnchor, document: { id: string; text: string }): boolean {
  if (anchor.documentId !== document.id || anchor.start < 0 || anchor.end > document.text.length) return false;
  const quote = document.text.slice(anchor.start, anchor.end);
  return quote === anchor.quote && crypto.createHash("sha256").update(quote, "utf8").digest("hex") === anchor.sha256;
}
