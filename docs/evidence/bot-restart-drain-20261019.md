# Controlled restart raced an in-flight browser request

Observer 15010 ended with a failed recovered trial (100398 ms). Worker resume
advanced past step 24 to step 27 and reached verification, proving the exhausted
worker fix on a real run. Baseline then failed on mobile restart scenario with
HTTP 403 for /api/tickets. Actual failure screenshot was saved as
.verification/7d8d217f-5696-43b7-851e-9374ca2cab46/mobile-6-failed.png.
No completion was delivered; independent checks and external probe were not reached.

Generated server has no 403 path. The verifier proxy maps caught bridge failures
to 403. Isolated Docker reproduction proved restart could kill a process while
it was serving an already-received request. Before fix:
bot-restart-inflight-1792393624344.json fails with rejected request. This establishes
a harness race; the archived trial lacks the original bridge exception, so it
does not conclusively identify every detail of that individual failure.

BackendSandbox now gates new requests during controlled restart and drains the
already-started request promises before killing the old process. Readiness uses
an internal direct request to avoid waiting on its own gate. Queued cancellation
is honored; concurrent restart is rejected; gate release is in finally. The
same container lifetime, network isolation, two-restart limit, signal and existing
request deadlines remain. No source edits to the generated application.

Actual Docker regression passes after fix, including old PID on completed slow
request, new PID on queued request, queued cancellation and concurrent restart
rejection: bot-restart-inflight-1792393753258.json. Existing restart/data-loss,
same-container, cancellation and lifetime tests pass (6945 exit 0). Typecheck
passes. Full verify/build passed (93324 exit 0). Installed at 10:14:22 Riyadh,
hash 9B774FC4158AF21534E20FA955041A3853109FB01FA591A15D75C0C024213898.
Installer evidence output/verification/bot-install-20261019-101415/verification.json
confirms profile and 148 tasks preserved. Resume was allowed without replay
confirmation; the next run rechecks the same artifact and frozen independent
contract. Previous failures remain unchanged.
Current observer 72052 writes bot-installed-tickets-fresh-full-gate-1792394086306.json.
All earlier observers for this task are terminal. A later pass is a recovered
result across runtime builds, never a fresh first-pass success. The filter
continuation remains unexecuted until an exact passing prior report exists.

Both restart commands are now in mandatory BOT runtime verification. Proxy 403
error reporting remains generic for other bridge failures; this is a remaining
diagnostic limitation, not a claim that every future 403 is fixed or app-caused.
