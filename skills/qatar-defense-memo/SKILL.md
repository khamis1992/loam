---
name: qatar-defense-memo
description: Use in Loam legal mode when drafting a defense memorandum (مذكرة دفاع) for a Qatari court, from the case facts and documents in the matter.
---

# Defense memorandum for a Qatari court (legal mode)

Follow every rule of the `qatar-legal-research` skill. In addition:

## Structure (markdown "## " headings, in this order)
1. `## بيانات الدعوى` — court, circuit, case number, hearing date, the parties and their capacities (from the matter; never invented).
2. `## الوقائع` — a neutral, dated account taken only from the documents in the matter. Mark anything assumed as an assumption.
3. `## الدفوع الشكلية والإجرائية` — only when they exist (jurisdiction, standing, limitation, procedure). Each plea: the rule (quoted and cited) → why it applies.
4. `## الدفاع الموضوعي` — one numbered defense per sub-heading: the rule (quoted and cited at the matter date) → the facts that meet it → the conclusion.
5. `## الطلبات` — primary requests (أصلياً) then alternative requests (احتياطياً), each precise and enforceable.

## Rules for the court text
- The memorandum is addressed to the court: no internal notes, no mention of tools, ids, file paths or the assistant. The disclaimer and the verification summary go on the internal cover sheet, not in the memorandum.
- Court of Cassation principles may be cited only if they are in the verified corpus; otherwise write `[غير موثّق — يحتاج بحث محامٍ]`.
- Dates: Gregorian `YYYY/MM/DD` in the text; keep Hijri dates exactly as they appear in the documents.

## Steps
1. Read the matter (facts, documents, court data). List the issues in dispute.
2. Research each issue with `legal_search` / `legal_article` at the matter's date.
3. Write the draft to `مذكرة-دفاع.md` in the task workspace.
4. Run `legal_memo_check` with `kind: "defense_memo"`; fix every error and re-run until it passes.
5. Tell the user the draft is ready for the lawyer review in the Legal panel; it exports as a watermarked draft until a licensed lawyer approves it.
