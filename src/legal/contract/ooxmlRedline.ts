import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { Document as XmlDocument, Element as XmlElement } from "@xmldom/xmldom";
import { wordDiff } from "./redline.js";
import { isClauseHeading } from "./clauses.js";
import { DRAFT_WATERMARK_AR } from "../review.js";
import type { Clause } from "../types.js";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";

export interface OriginalRedlineEdit { clauseId: string; newText: string }
export interface OriginalRedlineOptions { author: string; date: string; rtl: boolean; draft: boolean }

function element(doc: XmlDocument, name: string, text?: string): XmlElement {
  const node = doc.createElementNS(W, name);
  if (text !== undefined) node.textContent = text;
  return node;
}

function textOf(paragraph: XmlElement): string {
  return [...Array.from(paragraph.getElementsByTagNameNS(W, "t")), ...Array.from(paragraph.getElementsByTagNameNS(W, "delText"))].map((node) => node.textContent ?? "").join("");
}

function revisionRun(doc: XmlDocument, op: "del" | "ins", text: string, options: OriginalRedlineOptions, id: number): XmlElement {
  const container = element(doc, op);
  container.setAttributeNS(W, "w:id", String(id));
  container.setAttributeNS(W, "w:author", options.author);
  container.setAttributeNS(W, "w:date", options.date);
  const run = element(doc, "r");
  if (options.rtl) run.appendChild(element(doc, "rtl"));
  const textNode = element(doc, op === "del" ? "delText" : "t", text);
  textNode.setAttribute("xml:space", "preserve");
  run.appendChild(textNode);
  container.appendChild(run);
  return container;
}

function paragraph(doc: XmlDocument, oldText: string, newText: string, options: OriginalRedlineOptions, revision: { value: number }, pPr?: XmlElement): XmlElement {
  const p = element(doc, "p");
  if (pPr) p.appendChild(pPr.cloneNode(true));
  if (options.rtl && !pPr) p.appendChild(element(doc, "bidi"));
  for (const diff of wordDiff(oldText, newText)) {
    if (diff.op === "eq") {
      const run = element(doc, "r");
      if (options.rtl) run.appendChild(element(doc, "rtl"));
      const text = element(doc, "t", diff.text);
      text.setAttribute("xml:space", "preserve");
      run.appendChild(text);
      p.appendChild(run);
    } else {
      p.appendChild(revisionRun(doc, diff.op, diff.text, options, revision.value++));
    }
  }
  return p;
}

async function addDraftHeader(zip: JSZip, doc: XmlDocument, options: OriginalRedlineOptions): Promise<void> {
  if (!options.draft) return;
  const section = doc.getElementsByTagNameNS(W, "sectPr")[0];
  if (!section) throw new Error("DOCX section properties are missing");
  const reference = element(doc, "headerReference");
  reference.setAttributeNS(W, "w:type", "default");
  reference.setAttributeNS(R, "r:id", "rIdLegalDraft");
  section.insertBefore(reference, section.firstChild);
  const header = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="${W}"><w:p><w:pPr><w:bidi/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:rtl/><w:color w:val="B00020"/></w:rPr><w:t>${DRAFT_WATERMARK_AR}</w:t></w:r></w:p></w:hdr>`;
  zip.file("word/headerLegalDraft.xml", header);
  const rels = new DOMParser().parseFromString(await zip.file("word/_rels/document.xml.rels")!.async("string"), "text/xml");
  const relationship = rels.createElementNS(REL, "Relationship");
  relationship.setAttribute("Id", "rIdLegalDraft");
  relationship.setAttribute("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header");
  relationship.setAttribute("Target", "headerLegalDraft.xml");
  rels.documentElement!.appendChild(relationship);
  zip.file("word/_rels/document.xml.rels", new XMLSerializer().serializeToString(rels));
  const types = new DOMParser().parseFromString(await zip.file("[Content_Types].xml")!.async("string"), "text/xml");
  const override = types.createElementNS(CT, "Override");
  override.setAttribute("PartName", "/word/headerLegalDraft.xml");
  override.setAttribute("ContentType", "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml");
  types.documentElement!.appendChild(override);
  zip.file("[Content_Types].xml", new XMLSerializer().serializeToString(types));
}

export async function buildOriginalRedlineDocx(original: Buffer, clauses: Clause[], edits: OriginalRedlineEdit[], options: OriginalRedlineOptions): Promise<Buffer> {
  const zip = await JSZip.loadAsync(original);
  const documentXml = zip.file("word/document.xml");
  if (!documentXml) throw new Error("word/document.xml is missing");
  const doc = new DOMParser().parseFromString(await documentXml.async("string"), "text/xml");
  const body = doc.getElementsByTagNameNS(W, "body")[0];
  if (!body) throw new Error("DOCX body is missing");
  const paragraphs = Array.from(body.childNodes).filter((node): node is XmlElement => node.nodeType === 1 && (node as XmlElement).localName === "p");
  const headings = paragraphs.map((paragraph, index) => ({ index, text: textOf(paragraph) })).filter((item) => isClauseHeading(item.text));
  const hasPreamble = headings.length > 0 && paragraphs.slice(0, headings[0]!.index).some((paragraph) => textOf(paragraph).trim().length > 0);
  const offset = hasPreamble ? 1 : 0;
  const revision = { value: 1 };
  for (const edit of edits) {
    const clause = clauses.find((candidate) => candidate.id === edit.clauseId);
    if (!clause) throw new Error(`unknown clause ${edit.clauseId}`);
    const heading = headings[clause.index - offset] ?? (clause.index === 0 ? { index: 0, text: "" } : undefined);
    if (!heading) throw new Error(`clause ${edit.clauseId} could not be mapped to the original DOCX`);
    const start = heading.index;
    const end = headings[clause.index - offset + 1]?.index ?? paragraphs.length;
    const first = paragraphs[start]!;
    const pPr = first.getElementsByTagNameNS(W, "pPr")[0];
    const oldText = clause.text;
    const replacement = paragraph(doc, oldText, edit.newText, options, revision, pPr);
    for (const child of Array.from(first.childNodes)) {
      if (child.nodeType === 1 && ["drawing", "pict", "object", "bookmarkStart", "bookmarkEnd", "commentRangeStart", "commentRangeEnd", "proofErr"].includes((child as XmlElement).localName ?? "")) replacement.appendChild(child.cloneNode(true));
    }
    first.parentNode!.insertBefore(replacement, first);
    for (let index = start; index < end; index++) paragraphs[index]!.parentNode!.removeChild(paragraphs[index]!);
  }
  await addDraftHeader(zip, doc, options);
  zip.file("word/document.xml", new XMLSerializer().serializeToString(doc));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
