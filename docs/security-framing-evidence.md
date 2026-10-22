# Target-bound framing evidence — revision 36

The framing probe previously treated any console message containing `X-Frame-Options`, `frame-ancestors`, or a refusal phrase as proof of browser policy enforcement. Application JavaScript can print such messages. A framed application could therefore produce a false `not_observed` retest despite still rendering. A redirect into a different protected document could also incorrectly clear the original target observation.

The probe now gives an actually rendered direct target frame priority over console messages. A negative result requires both a denial signal and a successful response for the exact requested direct-frame navigation carrying a recognized enforcing policy. Redirected denial without that target response remains inconclusive. Query-changed and nested frames cannot count as the requested direct document.

Recognized restrictive policies are deliberately narrow: XFO `DENY`/`SAMEORIGIN`, or an enforced CSP policy whose first `frame-ancestors` directive is solely `'none'` or `'self'`. Other policy expressions may remain inconclusive. Enforced `frame-ancestors` takes priority over XFO; report-only CSP is not enforcement. This follows the [W3C CSP relationship to X-Frame-Options](https://www.w3.org/TR/CSP/#frame-ancestors-and-frame-options). Duplicate directives use the first value in each policy; separate comma-delimited policies remain independently enforced.

`src/scripts/check-security-framing-evidence.ts` runs a real Chrome fixture and baseline retests for: an open page, forged console denial, redirect into a protected page, actual XFO/CSP denial, permissive CSP overriding XFO, report-only CSP, and duplicate directives. It asserts persistent, not-observed and unverified fingerprint classifications, rather than only checking a screenshot or HTTP status. Source regression passed. Full-project typecheck subsequently passed after unrelated concurrent mobile-test edits settled; no mobile files were changed for this fix. Server build passed.

Revision 36 was installed on Loam 0.5.23, preserving the profile and 119 tasks. All four installed runtime/UI files matched the immutable staged candidate. Backup and verification record: `output/verification/security-runtime-backup-20261018-144715`.

The same eight-case baseline/retest regression also passed against the installed HTTP service using `LOAM_SECURITY_TEST_BASE=http://127.0.0.1:3939`. Its persisted task is titled `Framing evidence regression`; this verifies deployed execution and comparison behavior, not only source imports.

Framing findings remain review candidates: rendering alone does not demonstrate sensitive clickjacking impact. This revision strengthens evidence and retest correctness; it is not a claim of exhaustive browser-security coverage or frontier-level capability.
