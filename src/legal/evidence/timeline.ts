import crypto from "node:crypto";
import { foldDigits } from "../normalize.js";
import { documentParagraphAnchors } from "./anchors.js";
import type { EvidenceDocument, TimelineEvent } from "./types.js";

const DATE_PATTERNS = [
  /(?<day>\d{1,2})[\/-](?<month>\d{1,2})[\/-](?<year>\d{4})/d,
  /(?<year>\d{4})[\/-](?<month>\d{1,2})[\/-](?<day>\d{1,2})/d,
];

function validIso(year: number, month: number, day: number): string | null {
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

export function documentTimeline(document: EvidenceDocument): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const anchor of documentParagraphAnchors(document, document.id)) {
    const text = foldDigits(anchor.quote);
    for (const pattern of DATE_PATTERNS) {
      const match = pattern.exec(text);
      if (!match?.groups) continue;
      const iso = validIso(Number(match.groups.year), Number(match.groups.month), Number(match.groups.day));
        if (!iso) continue;
      events.push({
        id: `time-${crypto.createHash("sha256").update(`${document.id}|${anchor.start}|${iso}`).digest("hex").slice(0, 12)}`,
        matterId: document.matterId,
        dateLabel: match[0], sortDate: iso, description: anchor.quote.trim(), anchors: [anchor],
      });
      break;
    }
  }
  return events.sort((a, b) => a.sortDate.localeCompare(b.sortDate) || a.id.localeCompare(b.id));
}
