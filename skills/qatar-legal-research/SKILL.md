---
name: qatar-legal-research
description: Use in Loam legal mode for any question about Qatari legislation - finding the applicable article, checking whether a text is in force at a date, or tracing amendments - before stating any article number, law number or quotation.
---

# Qatari legal research (legal mode)

## Hard rules
1. Never state an article number, a law number, a date of a law or a quotation from memory. Every one comes from `legal_search` or `legal_article` in this run.
2. Quote the official text exactly, in «…», immediately followed by the token the tool returned: `«نص المادة كما ورد» ⟦cite:QL-xxxxxxxxxx⟧`. To refer again to a quoted article, use `⟦ref:QL-xxxxxxxxxx⟧`.
3. If a tool returns `NO_AUTHORITY` or `NOT_FOUND`, do not cite anything for that point. Write `[غير موثّق — يحتاج بحث محامٍ]` and say what was searched.
4. The applicable date is the matter's "as of" date (the date of the facts or the contract), not today, unless the user says otherwise. Pass `asOf` explicitly when the facts happened in the past.
5. If a result is `status=historical` or `NOT_IN_FORCE`, say so in the text ("بنصها قبل تعديلها بالقانون رقم …") and use `|historical` in the token.
6. Results marked `citable=NO` (unverified source) guide research only; they are never quoted as law.
7. Before presenting any answer that contains citations, run `legal_cite_check` on it. If the verdict is `fail`, follow the REFUSAL instructions; never present a failing text.

## Steps
1. Restate the legal question and the applicable date.
2. `legal_search` with the question in Arabic (and the law name if known). Read the returned text, not only the heading.
3. `legal_article` for each article you will rely on, to read the full text, the version history and the amendment chain.
4. Draft the answer: rule → quotation with token → application to the facts → caveats.
5. `legal_cite_check`; fix and re-check until it passes.
6. End with the caveats section and the disclaimer: «هذه المخرجات أعدّها مساعد آلي لدعم العمل القانوني، وليست بديلاً عن رأي محامٍ مرخّص في دولة قطر، ولا تُعد استشارة قانونية.»
