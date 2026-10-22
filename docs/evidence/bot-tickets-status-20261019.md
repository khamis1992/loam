# Installed ticket concurrency trial — passed after interruption and recovery

Final update 2026-10-19T04:10:41Z: observer 3559 exited 0. Persisted task status
is done, final verification passed before delivery, and the independent probe
passed. The final report has 12 passing desktop/mobile checks plus real visual
review. The independent probe used different competing update titles, checked
one winner and one conflict, invalid/stale updates, a subsequent valid version
increment, and exact SQLite rows. Source was not edited by the test operator.

Recovered observer elapsed time is 182317 ms. This is NOT the duration of the
original task and NOT an uninterrupted first attempt. Earlier failure remains
in bot-installed-tickets-docker-unavailable.json; the original incomplete
observer report is also retained. Current successful evidence is
bot-installed-tickets-recovered-live.json. Source, contract, screenshots and
report are archived in output/verification/bot-tickets-recovered-pass-20261019.
No observer for this task remains live. Historical updates below are retained.

The server-startup database deletion concern at the bottom remains unresolved:
this contract tests browser reload, not backend-process restart. Passing this
trial does not prove restart durability or broad agent parity.

Update 2026-10-19T04:07:35Z: Docker is ready again (server 29.8.0,
node:22-alpine sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2).
The failed recovered report was preserved as
bot-installed-tickets-docker-unavailable.json. With queue empty and recovery
resumable=true/requiresConfirmation=false/completedSteps=5, POST /resume with
an empty object resumed the SAME task. Current observer session is 3559;
old observers remain terminal. The task is running and the new verification
directory is eb969a26-72aa-47c3-983e-f12a5d36557d. No success is claimed yet.

Update 2026-10-19T04:04Z: observer 38124 terminated with exit 1. The task
ended `error` at 03:55:55Z because Docker's engine pipe was unavailable.
The recovered report is a failed trial, not a successful completion. The
historical active-observer statements below describe the earlier observation
and are superseded by this update. Do not poll either old observer again.
Runtime F3D8E496AC19BE38429AC3B0AA0493FF63733FD43FFDCF7B283E6924851786C2
has since been installed with a preflight-unavailable guard that preserves
application source and the final repair allowance. Docker recovery is ongoing;
this task has not yet been resumed after that installation.

Task `task_mvelv6se9c37881f3c13`, started 2026-10-19T01:58:36Z.
Original observer **21975** terminated with exit 1073807364. The installed
application was also absent (no Loam processes/listener); the cause is unknown.
Do not poll 21975 again. After starting the installed app once, startup took
longer than the first probes; it returned with the task `interrupted` and
two completed plan steps. Queue was empty. Read-only SQLite inspection of this
task's checkpoint showed nextStep=2, inFlight=true, fileOnlyTools=true and a
worker snapshot containing only one completed file_read, with lastRole=tool.
No pending write was present at that safe worker boundary.

The SAME task was explicitly resumed through /resume with retryInterruptedStep
true after inspecting that checkpoint. New observer **38124** is live and
reattaches to persisted task events; it does not POST a new chat. Poll this
handle and the original task API. All earlier transfer observers (18630,16168)
are terminal. This is an interrupted/recovered trial, not an uninterrupted run.

Command: `npx tsx src/scripts/check-bot-installed-tickets.ts`.
Evidence: `docs/evidence/bot-installed-tickets-live.json`.
Recovered observation evidence: `docs/evidence/bot-installed-tickets-recovered-live.json`.
Reattachment command: `npx tsx src/scripts/check-bot-installed-tickets.ts --observe-task=task_mvelv6se9c37881f3c13`.
Elapsed time in that new report measures reattached observation only; do not
present it as total task duration. Original evidence is retained unchanged.
Spec: `docs/evidence/bot-tickets-test-spec.json`.
Installed revision 9 / runtime SHA256:
`9BD50FD633395A85DCDD08D0B4136AAB85FB7C0EEC85B695E7D33EBB5D7DBFAE`.

New application domain: optimistic concurrent edits for a ticket tracker,
with exact API JSON contracts and persisted versions in SQLite. Six scenarios
run at both viewport sizes; API checks include exact content, concurrent
update winner, stale-version rejection, invalid bodies and missing records.
Independent probe uses different concurrent titles, checks the actual winner,
duplicate creation, invalid version types, stale rejection, subsequent valid
edit to version 3, and exact database contents.

Spec parsing and TypeScript passed. Task is running, with no result claim yet.
Do not claim success until all runner checks and independent probe pass.
No manual edits to generated application are authorized as part of this
autonomous-generation measurement; retain failures as failures.

Additional scope concern found during resumed observation: the original
planner explicitly requested deleting /tmp/tickets.sqlite at every startup,
and the generated server imports rmSync and removes DB_PATH plus sidecars
before CREATE TABLE. This is source evidence, not an executed restart test.
The current contract verifies page reload, not server-process restart; do not
claim the latter if this trial passes. Distinguish initially empty fresh
containers from destructive reinitialization on every application startup.
Investigate restart-preserving backend verification and initialization guidance
after this active trial finishes; do not change its contract retroactively.
