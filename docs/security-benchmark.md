# Independent benchmark evaluation — revision 62

The first section-24 increment: a planted ground-truth evaluation set for the ten dynamic vulnerability engines, run by `npm run check:security-benchmark` (`src/scripts/check-security-benchmark.ts`).

## The evaluation set

A benchmark application authored **after** the engines existed, with declared ground truth: per vulnerability class, **one vulnerable endpoint and one safe twin** (the same handler with the correct control — escaping, allowlists, stripping, validation). None of the engine development fixtures reuse these endpoints, and no engine was tuned against this app:

| Class | Vulnerable | Safe twin control |
|---|---|---|
| SQL injection | `/search?q=` | `/search-safe` (quote escaping) |
| Path traversal | `/files?name=` | `/files-safe` (segment rejection) |
| SSRF | `/fetch?url=` | `/fetch-safe` (host allowlist) |
| Template injection | `/render?tpl=` | `/render-safe` (data-only render) |
| XXE | `POST /api/xml` | `/api/xml-safe` (DOCTYPE stripping) |
| Deserialization | `POST /api/state` | `/api/state-safe` (function-tag stripping) |
| Command injection | `POST /api/lookup` | `/api/lookup-safe` (host validation, real shell on both) |
| Open redirect | `/go?to=` | `/go-safe` (in-origin allowlist) |
| File upload | `POST /api/upload` | `/api/upload-safe` (extension allowlist + retrieval view) |
| Reflected XSS | `/reflect?msg=` | `/reflect-safe` (HTML escaping, real Chromium) |

## Method

Four campaigns over the same app: the nine HTTP-only classes run as one campaign against the **vulnerable** endpoints and one against the **safe twins**; reflected XSS runs as a browser campaign pair. Per class the harness measures: **detected** (the engine's finding fired on the vulnerable endpoint) and **false positive** (any finding fired on the safe twin). The gate prints a per-class table and a summary, and fails if any planted vulnerability is missed or any safe twin is flagged.

## Result

**10/10 planted vulnerabilities detected, 0 false positives on the safe twins** — measured on this machine on 2026-10-18 by the gate above (the printed table is the primary evidence; re-run the gate to reproduce).

## Honest limits

- **Same-author bias**: the benchmark was written after the engines but by the same author in the same project — it is an independent *set*, not a third-party evaluation; the checklist item «مجموعة تقييم مستقلة لم تُستخدم أثناء التطوير» is satisfied only in the "not used during development" sense. A genuinely external benchmark (e.g., public CTF-style apps, OWASP benchmark projects) remains open.
- One representative endpoint per class with the engines' default canaries; variant classes (stored XSS, CSRF, business-logic families) are covered by their own gates but not by this set, and harder variants (WAF-style normalization, polyglots) are absent by construction.
- 10/10 on a ten-endpoint set is a floor, not a statistically meaningful detection rate; the set must grow before precision/recall claims generalize.

Worktree-only; not yet in an installed release. The historical 36-gate evidence applies to the older chain, not the current `verify:security` manifest chain.

## Mobile parser benchmark

`npm run check:mobile` also runs `src/scripts/check-mobile-bench.ts`: four independent report fixtures (two vulnerable and two benign, including false-positive traps) exercise the MobSF report parser. The required result is two true positives, two true negatives, and no false positives or false negatives. This is a small parser regression gate, not a statistically meaningful mobile detection-rate claim; external vulnerable/safe mobile applications and real devices remain required for that evaluation.

## Mobile scale acceptance corpus

`npm run check:mobile:scale` executes 20 additional loopback cases through the real authorization and business-scenario functions. The versioned corpus covers BOLA, anonymous access, order, quota, replay, offline state, recovery and refunds. Required result: 9 true positives, 9 true negatives, no false positives/negatives, and exactly two declared inconclusive negative controls. Unavailable or inconclusive cases are excluded from clean results rather than counted as successes. The command writes a machine-readable report to a temporary directory. This remains a regression corpus, not a global detection-rate claim.
