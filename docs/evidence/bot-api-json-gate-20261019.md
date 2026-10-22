# Exact API response validation — revision 9

Each declared API request can now include `expectedJson`. The gate parses the
actual backend body and compares exact JSON semantics: object key order is
ignored, types/fields/array ordering/duplicates are preserved. Explicit null
differs from absent expectation. Each response is matched to its own request,
including concurrent groups. Expectations are frozen during repair, and the
installed trial runner independently checks recorded response JSON.

Bounds: 16000 characters, 2000 values, depth 16. Invalid JSON, oversized or
mismatched bodies fail even with HTTP 200. A request without expectedJson
continues to perform only its status check. No dynamic expressions/wildcards.

Evidence:
- `check-bot-api-json.ts` passed using actual Docker/browser, fixture visual
  verdict: reordered object keys accepted; numeric string instead of number
  and malformed JSON with HTTP 200 rejected before visual review. Unit checks
  covered extra fields, array order/duplicates, null, structural budgets,
  per-request matching and frozen edits/removal.
- Report `docs/evidence/bot-api-json.json`.
- Existing `check-bot-api-contract.ts` passed, preserving previous status,
  SQLite and concurrent-request behavior.
- `npm run verify` passed including 114 orchestrator assertions.

Installed SHA256:
`9BD50FD633395A85DCDD08D0B4136AAB85FB7C0EEC85B695E7D33EBB5D7DBFAE`.
Report: `output/verification/bot-install-20261019-045639/verification.json`.
Capability revision 9, package version 0.5.25; profile and 143 tasks preserved.

No active task/observer remains. This feature has integration coverage, but a
new installed live-model task using expectedJson is still outstanding. It does
not automatically derive independent acceptance criteria or establish broad
agent parity. Earlier transfer generation failure and successful explicit
repair remain distinct results.
