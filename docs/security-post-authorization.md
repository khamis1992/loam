# Explicit POST authorization cases — revision 18

Multi-account API cases now support `method: "POST"` and `bodyRef`. GET remains the default. JSON bodies are supplied through temporary browser values, are limited to 8 KiB and must be objects. The same explicitly supplied body is used for the allowed and denied accounts; request bodies are not stored in the assessment. String values inside the body join the session redaction set.

Example case for an owned test endpoint:

```json
{"id":"record_lookup","kind":"api","path":"/api/lookup","method":"POST","bodyRef":"lookupBody","markerRef":"recordMarker","allowed":["alice"],"denied":["bob"]}
```

Temporary values include `"lookupBody": "{\"id\":\"synthetic-record-a\"}"` along with account credentials, expected identities and the expected record marker. The frontend path must be explicitly listed in `postPaths`; a separate API origin instead requires an exact API grant permitting POST. Cross-origin identity validation remains GET and requires its own granted identity path. Other HTTP methods are rejected for these cases.

POST can mutate application data. Select the endpoint and synthetic inputs deliberately; no endpoint enumeration or automatic payload generation is added. This feature does not infer whether a server treats a POST as read-only and does not provide transactional rollback of target data.

The allowed-account positive control, valid account/API identity before and after the request, successful transport, expected marker and explicit 401/403 denial semantics remain in force. Outage, invalid/expired sessions and missing positive controls remain inconclusive. Evidence includes method, request byte count, account, response metadata and linked positive-control proofs. Retests require fresh secrets and the exact original body, checked by a salted digest; changed request inputs require a new baseline.

Validation covers same-origin and cross-origin POST, JSON body validation, missing-grant rejection, both accounts' actual POST traffic, secret/body omission, fixed authorization, outage and expired-session retests, and body-change rejection. UI regression configures a POST case in the JSON field and checks that two account requests reached the fixture.

Commands: `npm run check:security-accounts`, `npm run check:security-cross-accounts`, `npm run check:security-http`, `npm run typecheck`.

This expands explicitly configured authorization testing; it is not general write-operation fuzzing or proof of complete API authorization coverage.

Revision 18 installed on Loam 0.5.15 preserving 56 tasks and the profile. Installed UI/API regression passed: the UI POST case reached both account requests and completed evidence/retest persistence checks. Backup: `output/verification/security-runtime-backup-20261018-112435`. Test screenshots: `C:/Users/khamis/AppData/Local/Temp/loam-security-http-Tk3igi`. Typecheck and server build passed.
