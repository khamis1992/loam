# Direct API acceptance gate — capability revision 8

Production adds optional scenario `apiChecks`: ordered groups, 1–4 concurrent
requests per group, exact status multiset, at most 8 groups / 16 requests per
scenario, local paths, bounded raw application/json bodies. No arbitrary code
or custom headers. 5xx cannot be accepted. Requests run inside the same backend
after browser screenshots and before SQLite inspection. Failures are reported
and block application verification before visual approval. Groups, requests,
bodies and expected status values are frozen by AcceptanceGuard during repair.

Validation:
- `check-bot-api-contract.ts` passed with actual Docker/browser/SQLite:
  correct duplicate concurrency, malformed JSON/blank identifier rejection;
  negative controls accepting blank identifiers and duplicating stored effects
  despite correct status codes were rejected. Frozen edits and schema bounds
  were checked. Visual verdict was a fixture in this integration test.
- `check-bot-api-transfers-holdout.ts` passed: unchanged source from the failed
  installed transfers task was rejected on BOTH viewports by the new API gate
  (actual 201 for blank identifier with sufficient stock vs required 400).
  The original failed trial remains failed, and generated code was not repaired.
- `npm run verify` passed, including 114 orchestrator assertions.

Reports: `docs/evidence/bot-api-contract.json` and
`docs/evidence/bot-api-transfers-holdout.json`.

Installed SHA256:
`13E0668D50BB4F6E56B4046FFABBACD5D646F99CCD46AC4D6D9F5F754B7D0296`.
Installer report: `output/verification/bot-install-20261019-044338/verification.json`.
Version 0.5.25, capability revision 8, profile and 143 tasks preserved.

Limitations: opt-in contract coverage, status checks plus optional subsequent
SQLite checks; response JSON semantics are not asserted. Concurrent statuses
are a multiset, not associated with individual requests (use single-request
groups for per-request status). Screenshots precede API effects. Existing
five-minute verification deadline remains. This is not automatic independent
criteria authoring or proof of generic concurrency correctness.

Next: extend the original transfer task contract explicitly with blank-input,
malformed JSON and concurrent replay tests, have BOT repair its own application,
and run the entire installed task / visual / SQLite / independent probe again.
No task or observer is active from this change. Previous transfer observer
18630 is terminal; original task task_mvekt3qa69bbc61f4011 is persisted done but
its independent trial is failed.
