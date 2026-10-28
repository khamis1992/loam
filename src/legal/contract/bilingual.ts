import crypto from "node:crypto";
import { foldDigits } from "../normalize.js";
import type { Clause } from "../types.js";
import type { Contradiction } from "../evidence/types.js";

function numbers(text: string): string[] {
  return foldDigits(text).match(/\d+(?:[.,]\d+)?%?/g) ?? [];
}

export function compareBilingualClauses(matterId: string, arabic: Clause[], english: Clause[]): Contradiction[] {
  const findings: Contradiction[] = [];
  const count = Math.min(arabic.length, english.length);
  for (let index = 0; index < count; index++) {
    const ar = arabic[index]!;
    const en = english[index]!;
    const arNumbers = numbers(ar.text).sort();
    const enNumbers = numbers(en.text).sort();
    const numericMismatch = JSON.stringify(arNumbers) !== JSON.stringify(enNumbers);
    const arLetters = (ar.text.match(/[\u0600-\u06FF]/g) ?? []).length;
    const enLetters = (en.text.match(/[A-Za-z]/g) ?? []).length;
    const ratio = enLetters / Math.max(arLetters, 1);
    if (!numericMismatch && ratio < 3.5) continue;
    findings.push({
      id: `bi-${crypto.createHash("sha256").update(`${ar.id}|${en.id}`).digest("hex").slice(0, 12)}`,
      matterId, kind: "bilingual", severity: numericMismatch ? "high" : "warning",
      title: numericMismatch ? "اختلاف أرقام أو نسب بين النسخة العربية والإنجليزية" : "احتمال نقص أو اختلاف جوهري في الترجمة",
      details: numericMismatch ? `العربية: ${arNumbers.join("، ")} | الإنجليزية: ${enNumbers.join(", ")}` : `نسبة النص الإنجليزي إلى العربي ${ratio.toFixed(1)}؛ راجع اكتمال الترجمة والمصطلحات.`,
      anchors: [],
    });
  }
  if (arabic.length !== english.length) {
    findings.push({
      id: `bi-count-${crypto.createHash("sha256").update(`${arabic.length}|${english.length}`).digest("hex").slice(0, 12)}`,
      matterId, kind: "bilingual", severity: "warning", title: "عدد البنود مختلف بين النسختين",
      details: `العربية ${arabic.length} بنود، الإنجليزية ${english.length} بنود. راجع الترقيم والملاحق.`, anchors: [],
    });
  }
  return findings;
}
