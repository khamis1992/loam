# Exhausted repair recovery and failure diagnostics

Installed observer 9434 terminated with error at 06:54:50Z, 772398 ms observation.
The independent mobile multi-create failure triggered automatic repair. BOT edited
index.html, but exhausted 24 worker steps before final verification. Its changes
remain UNVERIFIED. Archive: output/verification/bot-tickets-repair-budget-failure-20261019.
Original and all recovery failures remain separate entries in the trial summary.

Inspection revealed that resume loaded worker.steps=24 and started from 25 while
keeping maxSteps=24, producing immediate repeat failure. Source now grants one
additional configured worker slice only when an explicit checkpoint resume starts
an exhausted worker. Ordinary runs never auto-extend, and repeated exhaustion
still stops. Saved messages/tools, frozen contracts, usage and final verification
remain intact. API replay confirmation is unchanged. No live resume has occurred
after this change yet; the installed binary still has the old behavior.

New isolated test writes an actual file, reaches its one-step limit, resumes,
proves the write occurs exactly once and the final gate precedes completion.
A second case proves the resumed run stops after exactly one additional slice.
Existing before/after-tool/reject recovery tests still pass. These tests are now
part of mandatory runtime verification.

Failure screenshots: functional errors now retain a best-effort actual viewport
PNG, zero-based failed-step index, action and selector. Capture has a two-second
limit, skips cancellation/closed pages, and cannot replace the original error.
Diagnostic images are separate from successful screenshots and never constitute
a visual pass. Actual-browser failure tests verify PNG signatures and that no
visual judge is consulted for a failed interaction (61225 exit 0).

Parallel visual cancellation test also passed (89104 exit 0): both requests
settle before cancellation returns, with no surviving sibling operation.
Full verify/build passed (66363 exit 0). Installed all three improvements at
10:02:44 Riyadh as 8006789F1EBDB495450DDBA572DD7211BEC73CE08AC401B2D83A985D3392B240.
Installer evidence output/verification/bot-install-20261019-100237/verification.json
confirms profile and 148 tasks preserved. Prior parallel-only candidate superseded.

Before explicit replay confirmation, inspected the actual task: only file_read,
file_write, file_edit, file_list, file_stat, file_search and file_view_image; exact
isolated test workspace, stopped status error. Continued this authorized test via
retryInterruptedStep=true after installation. This confirmation is scoped to this
isolated evaluation, not authorization to replay arbitrary user-task effects.
Current observer 15010 writes bot-installed-tickets-fresh-full-gate-1792393382079.json.
The frozen independent contract is retained. No result is claimed yet.
