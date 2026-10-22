# Route-bound access assertions — revision 37

The single authenticated-versus-anonymous UI assertion previously compared selector visibility and HTTP status without checking the final route. An expired authenticated session redirected to a different page containing the same selector could act as a false positive control. A changed anonymous route could also produce a false exposure finding or an incorrect not-observed retest for the original page.

Both contexts must now retain the requested normalized URL, including query and fragment, before the assertion supplies finding or negative coverage. This matters for SPA hash routes as well as document redirects. Changed routes remain inconclusive even when a denial selector appears. Legitimate login redirects can therefore remain unverified; the result does not certify a server authorization fix from login UI alone.

Evidence retains authenticated/anonymous target-reached flags and sanitized final origin/path URLs. Query and fragment values are not copied into the new evidence fields. Existing requested assertion configuration remains subject to its prior persistence rules; do not put secrets in configuration paths. Existing findings still require review of the declared element's sensitivity and server API enforcement.

`src/scripts/check-security-access-route.ts` uses real Chrome and a local server. It establishes an anonymous-exposure baseline, then verifies authenticated-only and anonymous-only path movement, query changes, SPA fragment changes, an HTTP redirect into denial UI, and a direct HTTP 403 denial with a successful authenticated control. Changed-route findings remain unverified; a direct denial can become not observed. A separate changed-route baseline creates no false exposure finding. The fixture asserts that credentials and injected final-query/fragment values are absent from persisted results.

Source regression, full-project typecheck, and server build passed. The existing login/SPA/POST regression also passed, including cookies, CSRF/token handling, isolated sessions, fixed/unavailable retests and blocked redirects. Revision 37 was installed on Loam 0.5.23 with the profile and 121 tasks preserved. All four deployment files matched the staged candidate; backup: `output/verification/security-runtime-backup-20261018-145044`.

This change covers `accessAssertions`, not every multi-account or API authorization workflow. It does not demonstrate exhaustive authentication bypass testing or universal application repair. No Nutrio account or private session was used for these synthetic regressions.

The complete route regression also passed through the installed HTTP service (`LOAM_SECURITY_TEST_BASE=http://127.0.0.1:3939`). Persisted campaigns are available under the task `Access route evidence regression`, including baseline, six retests and the separate moved-route baseline.
