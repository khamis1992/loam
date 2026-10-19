# HTTP response completeness — revision 27

Revision 28 subsequently separates header-only checks from body reads; see `security-header-only-evidence.md`. Body-dependent checks retain the overflow protections described here. The header-check limitation below describes revision 27, not the revised behavior.

The basic HTTP transport previously stopped after retaining 32,768 bytes but reported a successful response. A form/error marker moved beyond that prefix could disappear from a retest while the discovery check was still counted as covered. Matching prefixes could also be used by the legacy authenticated/anonymous comparison without knowing the bodies were incomplete.

The transport now distinguishes an exact-limit completed response from overflow, including streamed/chunked bodies and decoded UTF-8 bytes. It retains at most 32,768 response bytes and cancels the reader on overflow. An oversized body has `bodyTruncated: true`, preserves its HTTP status, and is unsuccessful for assessment with an explicit incomplete-response reason. Request evidence records the flag. Existing error propagation makes the campaign partial and keeps missing baseline findings unverified.

The legacy protected-route comparison does not accept a truncated 401/403 as evidence of denial. Exposed-file probes also remain inconclusive when a 403/404/410 response is truncated. Neither a denial status nor a missing marker in a retained prefix establishes absence of protected content.

This conservative implementation also makes header-oriented checks inconclusive when their GET body is oversized. Header-only evaluation can be separated in a later change; this release does not silently certify coverage. The limit applies to basic HTTP transport, not the separate browser resource budgets. Previously saved reports retain their historical evidence and should be rerun; the change does not retroactively establish their completeness.

Validation: `check-security-http-body-limit.ts` covers 32,767/32,768/32,769-byte responses, chunked overflow, multibyte overflow, persisted truncation evidence, a password-form marker moved past the limit, a genuinely covered fixed response, a truncated denied protected response and truncated file-probe denials. The campaign regression and full TypeScript check also passed.

Additional transport controls passed for gzip expansion past the decoded-byte limit and a bodyless HEAD response. The full source-server HTTP/UI integration passed (`C:/Users/khamis/AppData/Local/Temp/loam-security-http-0RSQrT`).

Revision 27 was installed on Loam 0.5.19 with profile and 81 tasks preserved and runtime hashes verified. Backup: `output/verification/security-runtime-backup-20261018-123701`. Installed-runtime HTTP/UI regressions passed for evidence/export, account matrix, task isolation and retest persistence (`C:/Users/khamis/AppData/Local/Temp/loam-security-http-LmMsCO`). The oversized-response cases are exercised by the focused local transport/campaign test; the broader UI regression verifies integration compatibility, not every boundary case through UI controls.
