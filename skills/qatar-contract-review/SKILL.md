---
name: qatar-contract-review
description: Use in Loam legal mode when reviewing a contract under Qatari law - imported clause by clause, checked against the Qatari playbook, with proposed redlines.
---

# Contract review under Qatari law (legal mode)

Follow every rule of the `qatar-legal-research` skill. In addition:

## Steps
1. Import: `contract_import` with the matter id and the workspace file (.docx, .pdf, .txt, .md). The contract is stored encrypted and split into clauses.
2. Read: `contract_clauses`. If the text is withheld (egress policy), work from headings and categories only, and tell the user why.
3. Check: `contract_review` with the contract type. Treat findings as leads, not conclusions.
4. Confirm authorities: for every finding you keep, read each suggested authority with `legal_article` at the matter date. Use it only if it really governs the clause; otherwise write `[غير موثّق — يحتاج بحث محامٍ]`.
5. Report: write `مراجعة-العقد.md` with `## الملخص`, `## جدول البنود` (clause | issue | risk | recommendation | authority), `## التوصيات`, `## التحفظات` (with the disclaimer). Run `legal_memo_check` with `kind: "contract_report"` until it passes.
6. Redline: when the user asks for amendments, call `contract_redline` with `{clauseId, newText}` edits. The DOCX contains real Word tracked changes and is a watermarked draft until approved.

## Rules
- Never paste client text into web search or any external tool.
- Do not rewrite a clause the user did not ask to change.
- Keep the contract's language: Arabic clauses are redlined in Arabic; for bilingual contracts, flag inconsistencies between the versions instead of silently choosing one.
