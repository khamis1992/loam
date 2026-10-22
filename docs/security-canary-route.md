# DOM canary target continuity — revision 33

A DOM-fragment retest previously checked the canary's execution and resource errors without checking whether that specific navigation retained the target route. The initial rendering pass checked its route, but the canary runs in a separate browser context. An application can redirect only when a fragment is present. In that case, a clean login page could incorrectly produce `not_observed` for the original vulnerable page.

The canary now requires a successful main-document status and unchanged origin, pathname and query before attributing an observed or not-observed result to the requested target. A path or query change makes the proof inconclusive and leaves the baseline finding unverified. Actual canary execution is retained as evidence even when attribution is refused. The fragment itself is the probe input, so fragment changes are not treated as route changes by this check.

Proof observations include sanitized final URL, route-change and query-change flags, document status and `targetReached`. Query values and fragments are not recorded. The existing UI exposes these observations under browser evidence and preserves the unverified retest classification.

`src/scripts/check-security-canary-route.ts` starts a local HTTP application and verifies:

- A vulnerable positive control executes the local DOM marker.
- A fragment-specific path redirect leaves the baseline unverified.
- A query-only route change leaves the baseline unverified without revealing query values.
- Execution followed by a route change remains recorded but is not attributed to the original target.
- A real `textContent` repair retains the original target and produces `not_observed`.

The test passed against the source implementation. TypeScript, the server build, existing final-route regression, and reviewed repair reproduction/fix/rollback regression also passed. `not_observed` still describes this bounded reproducer, not proof that every XSS path or application behavior is repaired.

Revision 33 was installed on Loam 0.5.20 with all four runtime/UI hashes matching, the profile preserved and 97 pre-existing tasks retained. Backup: `output/verification/security-runtime-backup-20261018-140815`.

The same canary regression passed against the installed HTTP API with `LOAM_SECURITY_TEST_BASE=http://127.0.0.1:3939`. Full installed HTTP/UI integration also passed with `LOAM_SECURITY_TEST_REPAIRS=1`, covering account launch, matrix, evidence, export, task isolation, reviewed repair and retest/persistence. Screenshots: `C:\Users\khamis\AppData\Local\Temp\loam-security-http-JhT87L`. These tests used synthetic local applications in new tasks and did not access Nutrio accounts or modify Nutrio source.
