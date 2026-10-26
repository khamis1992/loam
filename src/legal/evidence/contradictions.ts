import crypto from "node:crypto";
import { foldDigits } from "../normalize.js";
import { paragraphAnchors } from "./anchors.js";
import type { Contradiction, EvidenceAnchor, EvidenceDocument } from "./types.js";

interface ValueEntry {
  key: string;
  value: string;
  date: boolean;
  anchor: EvidenceAnchor;
}

function entries(document: EvidenceDocument): ValueEntry[] {
  const out: ValueEntry[] = [];
  for (const anchor of paragraphAnchors(document, document.id)) {
    const text = foldDigits(anchor.quote);
    for (const match of text.matchAll(/(المبلغ|القيمة|الأجر|المدة|النسبة|تاريخ)[^\n\d]{0,40}(\d[\d.,]*)/gu)) {
      const key = match[1]!;
      const value = (match[2] ?? "").replace(/،/g, "").replace(/,/g, ".");
      out.push({ key, value, date: key === "تاريخ" || key === "المدة", anchor });
    }
  }
  return out;
}

export function detectContradictions(documents: EvidenceDocument[]): Contradiction[] {
  const groups = new Map<string, ValueEntry[]>();
  for (const document of documents) {
    for (const entry of entries(document)) {
      const group = groups.get(entry.key) ?? [];
      group.push(entry);
      groups.set(entry.key, group);
    }
  }
  const contradictions: Contradiction[] = [];
  for (const [key, values] of groups) {
    const unique = [...new Set(values.map((entry) => entry.value))];
    if (unique.length < 2) continue;
    const anchors = values.map((entry) => entry.anchor);
    contradictions.push({
      id: `conflict-${crypto.createHash("sha256").update(`${key}|${unique.join("|")}|${anchors.map((a) => a.sha256).join("|")}`).digest("hex").slice(0, 12)}`,
      matterId: documents[0]!.matterId,
      kind: key === "تاريخ" || key === "المدة" ? "date" : "amount",
      severity: "warning",
      title: `قيم متعارضة محتملة لـ«${key}»`,
      details: `ظهرت القيم ${unique.join("، ")} في مواضع مختلفة. هذه ملاحظة مراجعة وليست حكماً بوجود تعارض فعلي؛ تحقق من السياق والملاحق.`,
      anchors,
    });
  }
  return contradictions;
}
