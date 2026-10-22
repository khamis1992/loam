# Fresh installed persistence/concurrency evaluation

Task **task_mveumcvtdbf76a7e226c**, observer **78081**, started 06:03:40Z.
Output `bot-installed-tickets-fresh-full-gate.json`; fixed task/contract spec
`bot-tickets-fresh-full-gate-spec.json`.
Installed build D4678427CDD9CB657159F1073DFB6CF486293882578EB0031312D2CC6C79F00B.

Fresh generation, not continuation of the old ticket repair. Requires Arabic RTL
ticket UI, exact JSON API, SQLite, atomic compare-and-update version handling,
one winner for concurrent updates, strict invalid-input rejection and persistence
across two application process replacements. Supplied baseline has seven frozen
scenarios; runtime also independently authors tests. Both reports must pass on
identical source files, with every captured screenshot reviewed.

External holdout uses another ID and competing titles, checks duplicate/trim
behavior, actual one-winner update, two restarts with changed PIDs, rejected
invalid/stale versions, accepted next version and exact SQLite rows. Scope is
process persistence inside the same container, not host/container-deletion
durability. The probe was executed successfully against archived previously
working output before starting this new generation; that validates the probe,
not this new task. Typecheck passed (4853 exit 0).

Shared installed runner now preserves existing evidence in timestamped reports,
records runtime/prompt/contract hashes, rejects runtime changes during the trial,
requires independent report ordering and matching source hashes, and checks
complete screenshot coverage. Reattached observations scope stored events to the
exact latest user request, avoiding an earlier successful turn's evidence.
These are evaluation-tool changes; the installed runtime was not changed.

Initial attempt terminated with error at 06:20:54Z after 1,033,982 ms. All 14
desktop/mobile functional checks passed, including API/SQLite concurrency and
two process restarts. Visual review covered the first 12 screenshots, but the
remaining batch timed out within the shared five-minute application deadline.
Report pass=false, unavailable=true, visual.complete=false. No final success was
delivered. This is not a passing trial and the external holdout was not reached.

Preserved trial/report in output/verification/bot-tickets-fresh-visual-timeout-20261019.
Task recovery explicitly allowed resume without confirmation. Resumed the same
task without editing generated files, keeping installed build unchanged. Observer
52180 writes bot-installed-tickets-fresh-full-gate-1792390885363.json. A later
success must be labelled recovery, never substituted for the original failure.
Do not install/restart or modify generated files while this resumed task runs.
