# Independent author deadline and verification progress

Fresh quote task `task_mveslupm1aeaee6e3b6d` failed after 754160 ms
(~12m34 observation), despite all 12 baseline desktop/mobile checks and real
visual review passing. Independent author exceeded the old 90-second timeout.
The task correctly withheld completion. Preserve this failure in
`bot-independent-installed-quote-author-timeout.json`; no later recovery changes
the first attempt's outcome. Baseline report: `.verification/bba19cc2-0592-4ea5-a273-3c9d809df86d/report.json`
inside the task workspace. Desktop/mobile screenshots were also inspected by
the operator; the mobile screenshot shows a scrolled viewport, not the full page.

Changed independent author transport to one shared 180-second deadline with at
most two attempts, same messages/model/signal. Retry only transient connection,
429/5xx or timeout errors while budget remains; never retry content/schema/basis
refusal. Cancellation and late returns are rejected. Known successful-response
usage remains accounted; failed provider calls may have unreported billable work.

Added `verification_progress` events for creative, baseline application,
independent author, independent application and final review. Task overview
renders pending stages without implying success; terminal/verdict events clear
progress. Installer optionally stages, hashes, backs up and restores task-view.js
together with the runtime.

Validation: UI model test passed; full verify including mandatory independent
author and all seven gate tests passed (69103 exit 0). Additional typecheck and
build passed after observer edits. Logs: bot-author-deadline-20261019.log and
bot-verification-progress-20261019.log under output/verification.

Installed 08:23 Riyadh, profile and 146 tasks preserved:
`output/verification/bot-install-20261019-082333/verification.json`.
Runtime SHA256 F4B84F485F9E52025279B5F8D1E9AC513120764CBF2C03884F7E8BA59E1DBD88.
UI SHA256 E909AE0448625BA3A0892538B07BEDFEED7719F56486D6AB71698516C1D84DD8.

Resumed SAME task from all four completed steps; recovery required no uncertain
action confirmation. Observer **89993** writes
`bot-independent-installed-quote-resumed.json`, explicitly marked reattached.
It uses persisted events, not the original live SSE stream, checks the original
prompt and single user turn, and never creates a task. It retains the unchanged
external quote holdout. Evaluation remains pending; no parity claim.
