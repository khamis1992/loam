# Backend process restart verification

FINAL UPDATE 04:30Z: live same-task repair PASSED, observer 15127 terminal
exit 0. Duration 667332 ms (~11m07), 44 reported steps. All 14 browser/API/
SQLite checks and real vision passed, followed by the independent probe:
two different application processes, state persisted, stale version rejected,
valid subsequent update preserved as [persist, after restart, open, 3].
The source was repaired by BOT, without operator edits. Cloud HTTP 502 occurred
and fallback was attempted during this successful round; preserve that event
as part of the reliability evidence. The prior generation/recovery failures
remain separate, not reclassified as first-pass success.

New installed-case PID assertions were added after this observer started;
equivalent assertions were executed separately against the final saved report
and passed (one changed-PID record per restart on each viewport). Full report,
source and screenshots: output/verification/bot-tickets-restart-pass-20261019/.

Installed cancellation-guard build after queue became idle:
3EAF4024E51A94DC986835CFEA6F402E0F8419B880DAFC2ABE588877C72AAFA1,
revision 10/version 0.5.25. Profile and 144 tasks preserved. Installation report:
output/verification/bot-install-20261019-072953/verification.json.
No active ticket observer or pending BOT runtime install remains. The successful
live round used preceding hash 73151D0F..., while the final cancellation-only
guard has deterministic/container regression and full verify coverage.
All historical active/pending statements below are superseded by this update.

Update 04:23Z: full npm run verify now PASSED (observer 17471 exit 0).
Log: output/verification/bot-restart-full-verify-20261019.log. Null text values
in the two voice scripts now fail their existing nonempty regex assertions
using an empty-string fallback, and the existing cancellation comparison uses
explicit Number conversion. This supersedes the earlier typecheck blocker
below; it does not claim those voice UI tests were executed.
Live ticket restart observer 15127 remains active at this checkpoint.

Update 04:27Z: live trial encountered an actual cloud-provider HTTP 502 at
04:25:01Z and automatically attempted local fallback qwen2.5:14b. Subsequent
file-read/step events and a passing critique at 04:26:36Z confirm progress;
the same task reached actual Docker/browser verification, directory
1ed2c992-fa24-435e-a00e-28e095123195. It is not terminal yet. Desktop scenario
6 screenshot visibly retains ticket a, updated title, closed status/version 2.
No final success or independent-probe result is claimed from that screenshot.

Additional source correction: an already-aborted restart now exits before
consuming its restart allowance. Expanded check-bot-backend-restart passed
(session 3448 exit 0): cancellation preserves both attempts and real restart
does not extend the original 6000 ms container lifetime (exit 124). Full verify
and build passed (50252 exit 0), log bot-restart-cancel-verify-20261019.log.
Pending candidate SHA256:
3EAF4024E51A94DC986835CFEA6F402E0F8419B880DAFC2ABE588877C72AAFA1.
Not installed while task/observer 15127 is active; installed runtime remains
73151D0F... revision 10. Install only after queue/assessments are idle.

Added restartBackend contract action for isolated Node applications. It kills
the generated application's process group with SIGKILL, starts a replacement
through the existing supervisor, confirms a different child PID using procfs,
waits for HTTP readiness and reloads the browser. The container and /tmp remain
alive. Restarting does not reset the fixed lifetime timer. At most two restarts
per scenario are accepted by both schema and runtime. Restart steps participate
in the existing frozen acceptance signature. Reports retain old/new PIDs.

Instructions now distinguish page reload from server-process restart and
require non-destructive database initialization. Restart checking is explicit
and opt-in; there is not yet automatic independent persistence-test authoring.
This does not prove survival of container deletion, host failure, or storage
outside the bounded temporary filesystem.

Validation passed:
- check-bot-backend-restart.ts: actual Docker/browser/SQLite, two restarts per
  viewport, source deleting SQLite at startup rejected before fixture vision,
  frozen restart step, bounds, same container ID/start time and retained rows.
- check-bot-backend-sandbox.ts and check-bot-backend-app.ts: isolation, resource
  limits, lifetime expiry, cleanup and existing browser/backend behavior.
- check-bot-restart-holdout.ts: unchanged archived generated ticket source
  rejected on both viewports after process restart; independent SQLite read
  proves one row before restart and zero afterward. Hashes preserved.
- All production/BOT TypeScript passed with output/verification/
  tsconfig-bot-restart.json, which explicitly excludes two unrelated voice
  scripts. Encoding, eval, orchestrator, recovery, modes and bot-runtime passed.

Full npm run verify did NOT pass: check-companions-voice.ts and dbg-voice.ts
have unrelated type errors. Five missing template-literal terminators in the
former were corrected, but null/unknown typing and the debug script's DOM
references remain. Do not report the scoped check as a full-tree pass.

Installed runtime SHA256:
73151D0FDC96668B1C026D5D64120AC9B7E5F22628DEFF56DBBD2E6D5CB7B69C.
Capability revision 10, package 0.5.25. Install report:
output/verification/bot-install-20261019-071713/verification.json.
Profile and all 144 tasks preserved.

Live continuation started 04:18:19Z on SAME task
task_mvelv6se9c37881f3c13. Observer session 15127 is running. Command:
npx tsx src/scripts/check-bot-tickets-restart-live.ts.
Spec: bot-tickets-restart-spec.json; result: bot-tickets-restart-live.json.
The six original scenarios are retained unchanged, plus one two-restart
scenario. An independent probe creates/updates a different ticket, restarts,
checks its exact JSON/version, rejects a stale update, performs a valid update,
restarts again and checks exact SQLite/API state. Source repairs must be made
by BOT, not manually by the operator. Outcome remains unproven until observer
finishes; inspect the persisted task if observation stops. Do not start a
duplicate continuation based only on an observation timeout.
