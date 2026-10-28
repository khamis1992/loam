import crypto from "node:crypto";
import { documentParagraphAnchors } from "./anchors.js";
import type { EvidenceDocument, FactAssertion } from "./types.js";

export function documentFacts(document: EvidenceDocument, now: () => Date = () => new Date()): FactAssertion[] {
  return documentParagraphAnchors(document, document.id)
    .filter((anchor) => anchor.quote.trim().length >= 20)
    .map((anchor, index) => ({
      id: `fact-${crypto.createHash("sha256").update(`${document.id}|${index}|${anchor.sha256}`).digest("hex").slice(0, 12)}`,
      matterId: document.matterId,
      text: anchor.quote.trim(),
      kind: "documented",
      status: "unreviewed",
      anchors: [anchor],
      createdAt: now().toISOString(),
    }));
}
