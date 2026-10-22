# Visual batch transport diagnostics

Repeated installed application verification reached fourteen successful functional checks but could not finish a two-image visual batch. Before this change, reports retained successful model responses but did not include a structured record for every attempted screenshot batch.

`AppEvidence.visual.batchRuns` now records the batch ordinal, exact screenshot paths, start time, elapsed milliseconds, response/unavailable state, attempt count, and bounded transport error. A response is explicitly not a pass: semantic verdict validation remains separate. All concurrent calls settle before the report is finalized, and the existing shared deadline, two-attempt retry limit, source integrity check, and requirement to review every screenshot are unchanged.

Validation passed: `npm run typecheck` and `npm run check:bot-visual-batches`, covering successful reviews, early/late semantic rejection, early/late HTTP 503 exhaustion, and cancellation of both concurrent calls. This uses real browser captures with a fixture visual model, not evidence of real provider reliability.

Full `npm run verify` and `npm run build:server` passed (session 92732, exit 0). Log: `output/verification/bot-batch-diagnostics-verify.log`. Candidate SHA256: `4CAAED2B99C94E8765988474E663F7CAB636CCCFA144F63DA8065839AB14BB3C`.

The change is built but not installed. The live retry remains on installed runtime `815A3286C0E4A9D6B0302DC88719B6033668CD333AE855D67606C05247207D4E`, observer evidence `bot-installed-tickets-fresh-full-gate-1792395796648.json`. Do not replace its runtime while it is active. This diagnostic change does not claim to fix provider timeouts or the generated application's unresolved mobile interaction defect.

Installation update: after that retry terminated, installed candidate `4CAAED2B99C94E8765988474E663F7CAB636CCCFA144F63DA8065839AB14BB3C` at 10:55 Riyadh. Evidence `output/verification/bot-install-20261019-105525/verification.json` confirms profile/148 tasks preserved. A fresh nine-trial fixed-build cohort is now running; this installation supersedes the pending status above.

Live installed evidence: quote task `task_mveymll94409cd147f72` baseline report `.verification/7c66e9de-bd2e-4644-b375-63fcc08d7249/report.json` passed twenty functional checks and reviewed all twenty screenshots at 08:19:57 UTC. Total baseline elapsed 110693 ms; batch diagnostics recorded two completed responses in 22808 ms and 14757 ms, one attempt each. This validates the new diagnostics on a real provider response. It does not yet prove task completion: independent acceptance and external holdout were still pending when recorded.
