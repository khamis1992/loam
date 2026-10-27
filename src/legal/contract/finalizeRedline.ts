import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { Document as XmlDocument, Element as XmlElement } from "@xmldom/xmldom";
import { DRAFT_WATERMARK_AR } from "../review.js";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";

function children(parent: XmlElement | XmlDocument, namespace: string, name: string): XmlElement[] {
  return Array.from(parent.getElementsByTagNameNS(namespace, name));
}

export async function finalizeApprovedRedlineDocx(draft: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(draft);
  const documentXml = zip.file("word/document.xml");
  const relationshipsXml = zip.file("word/_rels/document.xml.rels");
  const typesXml = zip.file("[Content_Types].xml");
  if (!documentXml || !relationshipsXml || !typesXml) throw new Error("invalid redline package");
  const doc = new DOMParser().parseFromString(await documentXml.async("string"), "text/xml");
  const rels = new DOMParser().parseFromString(await relationshipsXml.async("string"), "text/xml");
  const types = new DOMParser().parseFromString(await typesXml.async("string"), "text/xml");
  let removed = 0;
  for (const reference of children(doc, W, "headerReference")) {
    const id = reference.getAttributeNS(R, "id");
    const relationship = children(rels, REL, "Relationship").find((item) => item.getAttribute("Id") === id);
    const target = relationship?.getAttribute("Target");
    if (!relationship || !target) continue;
    const headerPath = `word/${target.replace(/^\//, "")}`;
    const header = zip.file(headerPath);
    if (!header || !(await header.async("string")).includes(DRAFT_WATERMARK_AR)) continue;
    reference.parentNode!.removeChild(reference);
    relationship.parentNode!.removeChild(relationship);
    for (const override of children(types, CT, "Override")) {
      if (override.getAttribute("PartName") === `/${headerPath}`) override.parentNode!.removeChild(override);
    }
    zip.remove(headerPath);
    removed++;
  }
  if (removed !== 1) throw new Error("approved redline must contain exactly one draft watermark header");
  zip.file("word/document.xml", new XMLSerializer().serializeToString(doc));
  zip.file("word/_rels/document.xml.rels", new XMLSerializer().serializeToString(rels));
  zip.file("[Content_Types].xml", new XMLSerializer().serializeToString(types));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
