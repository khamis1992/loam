import type { Matter } from "../types.js";
import type { QualityIssue } from "../analysis/types.js";

export function proceduralFlags(matter: Matter, now: Date = new Date()): QualityIssue[] {
  const issues: QualityIssue[] = [];
  if (!matter.court?.name) issues.push({ code: "missing_court", message: "Court or competent authority is not recorded" });
  if (!matter.court?.caseNumber) issues.push({ code: "missing_case_number", message: "Case number is not recorded" });
  if (matter.parties.length === 0) issues.push({ code: "missing_parties", message: "No parties are recorded" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(matter.asOf)) issues.push({ code: "invalid_as_of", message: "Applicable-law date is invalid" });
  const hearing = matter.court?.hearingDate;
  if (hearing && !/^\d{4}-\d{2}-\d{2}$/.test(hearing)) issues.push({ code: "invalid_hearing_date", message: "Hearing date is invalid" });
  else if (hearing && hearing < now.toISOString().slice(0, 10)) issues.push({ code: "hearing_in_past", message: "Recorded hearing date is in the past and needs confirmation" });
  return issues;
}
