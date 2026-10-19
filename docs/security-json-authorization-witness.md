# Exact JSON authorization witnesses — revision 19

API authorization cases may specify `markerPath`, a JSON Pointer string, alongside the existing secret `markerRef`. Example: `"markerPath":"/records/0/id"`. The selected value must be a string exactly equal to the expected marker; matching unrelated error text or a substring is insufficient. Nested objects, array indices and `~1` / `~0` escaping are supported. The empty pointer selects the root. Pointer syntax is bounded to 300 characters; URI-fragment pointer notation is not accepted.

GET and explicit POST cases share this witness mechanism, including separate API origins. Evidence records `witnessMode` and the pointer, not the protected value or response body. Retests preserve the original pointer and pinned expected marker. Existing account identity and allowed-control requirements remain unchanged.

Response interpretation:
- A successful allowed-account request must reproduce the exact field value.
- A denied account reproducing the value proves the declared boundary failed, including when the HTTP response is 401/403 but still contains that data.
- Echoes in other fields, malformed JSON, missing fields and substring-only matches on a 200 response remain inconclusive, not fixed.
- Explicit 401/403 without the witness can establish denial only with valid identities and successful positive controls.
- Without `markerPath`, legacy text matching remains available. A text marker appearing in a 401/403 body is now inconclusive because it may be either a leak or an echo; it is never certified as a repair from the status alone.

The operator must select a meaningful protected field and synthetic marker. A server can echo values in the selected field too; field matching is evidence under the declared test policy, not independent proof of record ownership. Parsing follows JavaScript JSON semantics (including last-value handling of duplicate keys); this is not a general JSON Schema validator or complete RFC conformance test suite.

Validation: `check-security-json-witness.ts` exercises nested/escaped pointers, invalid pointer syntax, exact matches, echo/malformed/substring/missing outcomes, data leaked with 403, legacy ambiguity and fixed retests. Cross-origin GET/POST account tests and the UI regression use exact JSON fields. Typecheck and source integration tests passed.

JSON Pointer syntax reference: https://www.rfc-editor.org/rfc/rfc6901

Revision 19 installed on Loam 0.5.15, preserving 59 tasks and the profile. Installed UI regression passed, including exact JSON fields in POST cases and retest persistence. Backup: `output/verification/security-runtime-backup-20261018-113053`. Test artifacts: `C:/Users/khamis/AppData/Local/Temp/loam-security-http-D9KnmV`. The latest dedicated witness regression also passed the structured 403-leak and legacy ambiguous-denial cases. Typecheck and server build passed.
