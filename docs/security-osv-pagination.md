# OSV pagination — revision 31

Opted-in advisory matching now follows per-package pagination tokens using the same batch endpoint. Follow-up batches contain only unfinished packages, preserving the package/version/token association. Advisory IDs are deduplicated into one finding per package/version. `queried` counts unique packages with accepted results; `completed` counts packages whose final page was received; `requests` counts batch attempts.

Limits: 100 packages per batch, 1,000 eligible unique packages, ten pages per package, 50 total requests, 2 MB per response and 20 MB cumulative response data. Tokens are capped at 4,096 characters and repetition is rejected. Advisory IDs are capped at 10,000 per package. Limit exhaustion, malformed responses, outages and cancellation retain accepted findings but mark the audit incomplete. Cancellation still propagates to the campaign.

The [OSV batch contract](https://google.github.io/osv.dev/post-v1-querybatch/) specifies per-result continuation tokens and ordering. Only previously opted-in package metadata and provider tokens are sent back to the fixed OSV endpoint; redirects remain disabled. No new external service is introduced. Matching does not establish runtime reachability or choose a safe upgrade version.

`check-security-osv-pagination.ts` verifies selective continuation, token/package alignment, duplicate IDs, unique-package counters, repeated tokens, page bounds, later-page outage and cancellation retention using injected provider responses. `check-security-dependency-coverage.ts` and the campaign regressions remain applicable. The paginated cases are deterministic contract tests, not claims that a live public package returned multiple pages during this run.

A 1,000-package contract fixture also verifies the global 50-request cap: 800 packages complete, 900 have accepted initial results, no 51st request is sent, and the overall audit remains incomplete.

Deployment verified on 2026-10-18: after an interrupted installation attempt, the running service's revision number alone was insufficient because its server hash differed from the current build. A fresh build and guarded installation restored matching runtime/UI hashes. Installed identity reports Loam 0.5.19 and security revision 31; package source is 0.5.20, so these version identifiers are not conflated. The profile and 90 existing tasks were preserved. Backup: `output/verification/security-runtime-backup-20261018-135334`.

Full-project typecheck, pagination tests and installed-runtime HTTP/UI regression passed. Installed evidence/export, account matrix, source/dependency coverage, task isolation and retest persistence passed; screenshots: `C:/Users/khamis/AppData/Local/Temp/loam-security-http-FmBFKD`. This UI regression verifies integration compatibility; multi-page provider behavior is covered by the injected-response tests, not a live OSV multi-page run.
