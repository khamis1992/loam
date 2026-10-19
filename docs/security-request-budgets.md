# Request budgets for large SPA applications

Security engine revision 12 raises the configurable request ceiling from 1,000 to 10,000. The default remains 200. The UI and server validate the same range (10–10,000), and the UI rejects larger budgets against older engines. Existing campaigns and retests retain their original limits; no automatic escalation is performed.

This addresses an observed Nutrio development-build limitation: a five-page campaign consumed all 1,000 requests loading Vite modules before protected routes could render. Raising the byte limit alone did not resolve the request-count limit. A higher request allowance still does not provide credentials, API-origin grants, or evidence of authenticated coverage.

The existing serialized request reservation enforces the campaign-wide ceiling across HTTP and browser requests. Time, decoded-byte limits, scope and credential isolation continue to apply. Diagnostics explicitly explain when the recorded requests reach the ceiling. Reaching exactly the ceiling is a prompt to review coverage, not by itself proof that an otherwise completed run is incomplete.

Validation:

- `npx tsx src/scripts/check-security-request-budget.ts`: concurrent reservations cannot exceed the bound; the local fixture receives exactly 1,000 requests under a 1,000-request budget; the SPA requiring 1,010 resources renders with an explicit 2,000-request budget; retest preserves that budget and completes.
- UI integration regression enters 2,000 in the request limit and verifies the persisted server-side campaign value.
- Larger campaigns can increase server load and evidence size. The operator selects the budget explicitly; duration and pacing remain independently configurable.

This is a capacity improvement, not additional vulnerability-class coverage or a claim of frontier-level completeness.

## Installed and Nutrio verification

Installed revision 12 verified on 2026-10-18. A concurrent Loam 0.5.14 installer interrupted the first installed-runtime regression; after that installer exited and Loam restarted, the full installed UI/API regression passed, including a 2,000-request budget, account matrix, evidence and retest persistence. Type checking and server build also passed.

Nutrio run `b60cbde6-1ee4-4b0d-876a-811a03186ed2` repeated the original broad anonymous campaign with only the request budget increased to 3,000. Four render attempts verified document completion, network settling and the configured anonymous readiness selector, with zero failed resources/runtime errors. The `/nutrio/meals` attempt timed out at readiness; it remains inconclusive. The campaign finished partial (38/38 planned checks processed), with 125,496,855 browser response bytes. No authenticated API coverage is claimed. See `output/verification/nutrio-revision12.json` for evidence.
