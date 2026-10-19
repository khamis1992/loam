# Anonymous API collection checks — revision 35

The browser engine now supports explicit `anonymousApi` cases through the security UI. This brings the targeted anonymous collection checks used for Nutrio into persisted campaigns, browser/request evidence, diagnostics, exports and baseline retesting.

Each case names an exact granted API origin/path, optional literal query parameters, a JSON Pointer to an array (`collectionPath`, empty for the root), and an expected public/private classification. An optional `publicKeyRef` supplies only the explicitly granted `apikey` header from temporary values. Authorization headers, cookies and user storage are not imported. Known Supabase secret keys and non-anon JWT roles are rejected; arbitrary opaque keys still depend on the operator correctly designating them as public application keys.

A synthetic document at the approved frontend origin provides real browser CORS semantics without running the application or establishing a login session. All API traffic still crosses the existing scope, request-budget, byte-budget, timeout and redirect guards. Requests use GET, `credentials: omit`, no-store cache and redirect rejection. Query settings are persisted for reproducibility: they must contain non-secret test values. Response contents are processed in memory but are not retained in proofs, which record row counts, status, hashes and request IDs.

A negative fixture demonstrated that Playwright request interception can expose a fulfilled response despite missing CORS headers. This module therefore explicitly verifies the response origin and sends a budgeted OPTIONS preflight for its custom `apikey` header, checking origin, GET method and allowed header before sending GET. Preflight bodies are deliberately omitted and marked as such in evidence. A rejected preflight prevents GET; a rejected response becomes inconclusive. This bounded check applies to these anonymous cases, not a claim to implement the complete Fetch/CORS standard or to retrofit every older browser flow.

Private cases reference a public collection control with the same API origin and key reference. That control must return a nonempty array before and after the target request:

- Nonempty declared-private collection: a review finding, including if rows appear in a 401/403 response. The operator's data-classification declaration requires verification; row count alone does not prove sensitive data exposure.
- Explicit 401/403 JSON denial with successful controls: the observation is not reproduced for this case.
- Empty array, missing/wrong collection shape, invalid JSON, failed control, CORS failure, redirect or transport outage: inconclusive. Empty data does not prove a fix.

Public keys are pinned by salted hash for retesting, alongside the existing witness digests. Changed keys require a new baseline. No finding is automatically closed. Cases that remain inconclusive add coverage notifications to exports.

Example UI configuration (also grant GET on both paths and `apikey` for this API origin):

```json
[
  {"id":"catalog","origin":"https://api.example.test","path":"/catalog","collectionPath":"","expected":"public","publicKeyRef":"publicKey"},
  {"id":"private_records","origin":"https://api.example.test","path":"/records","query":{"limit":"1"},"collectionPath":"","expected":"private","publicKeyRef":"publicKey","controlId":"catalog"}
]
```

Validation script: `src/scripts/check-security-anonymous-api.ts`. Local two-origin fixtures cover nonempty/empty collections, true denial, denial with leaked rows, malformed/wrong-shape JSON, unavailable/expired controls, outages, redirect rejection, scope/key validation, omission of cookie/authorization headers, content/key redaction and pinned-key retesting. Installed mode additionally fills the real UI configuration and checks evidence, diagnostics and temporary-value clearing. These checks do not cover write operations, RPC side effects, arbitrary scalar JSON data, user-to-user isolation or all anonymous access paths.

Source regression and full HTTP/UI integration passed (screenshots `C:\Users\khamis\AppData\Local\Temp\loam-security-http-DaogFw`). Full-project typecheck initially encountered a concurrent unrelated swarm-test diagnostic; the subsequent complete typecheck passed without changing that test. Server build and UI syntax checks passed.

Initial revision 35 installation on Loam 0.5.21 preserved the profile and 106 tasks, with all four runtime/UI files matching. Backup: `output/verification/security-runtime-backup-20261018-142838`. Installed anonymous-API regression and UI launch both passed; screenshot `C:\Users\khamis\AppData\Local\Temp\loam-anonymous-api-VCY22M\anonymous-api-ui.png`. A subsequent actual Nutrio campaign was interrupted by the independently running Loam 0.5.22 installer; no security conclusion is drawn from that interrupted observation.

Final CORS regression passed against the installed server, including missing response CORS, rejected preflight and an assertion that rejected preflight sends no GET. UI evidence: `C:\Users\khamis\AppData\Local\Temp\loam-anonymous-api-h13p9S\anonymous-api-ui.png`. After another concurrent application update, revision 35 was installed on Loam 0.5.23 with 118 tasks and profile preserved; backup `output/verification/security-runtime-backup-20261018-144307`. Installation now stages immutable candidate files so a concurrent workspace rebuild cannot invalidate the post-restart comparison.

The final Nutrio campaign `a5986512-0ac9-4528-bad0-7b3892b4cc2b` completed with partial coverage: 11 GETs and 11 OPTIONS against the approved API. Both public controls returned one row; the three private cases returned empty arrays and remained inconclusive. Evidence and UI screenshot: `output/verification/nutrio-anonymous-platform.json` and `.png`. This actual campaign was launched via the platform API and its results verified in the installed UI; the local regression separately verified launch through the form.
