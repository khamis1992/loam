# Installed stock-transfer trial

Started 2026-10-19T01:28:59Z after specification parsing and TypeScript passed.
Task: `task_mvekt3qa69bbc61f4011`.
Runner: `src/scripts/check-bot-installed-transfers.ts`.
Report: `docs/evidence/bot-installed-transfers-live.json` (pass remains false
until terminal status, all acceptance checks and independent probe succeed).
Observer exec session: 18630. Poll it and the task API; do not restart the
trial just because an observation call yields or times out.

Scope: a new RTL stock-transfer application with real SQLite, atomic debit /
credit / transfer-record updates and idempotency keys. Seven scenarios run at
both viewport sizes with real visual review and two-table SQL inspection.
The independent probe checks duplicate concurrent requests, competing stock
transfers, rollback, invalid numeric inputs, malformed JSON, reverse transfer
and exact final stock/ledger contents.

Final state: task persisted `done`, but the overall independent trial FAILED.
Observer session 18630 exited 1 and is terminal; do not poll/restart it.
Elapsed time 552086 ms (about 9m12s), reported execution steps 34.
All 14 browser/SQLite checks and real visual review passed. The independent
API probe passed concurrent duplicate requests (200/201), retry with
insufficient remaining stock (200), conflicting identity (409), competing
stock transfers (201/409), and invalid numeric quantities (400), then failed
on a whitespace-only requestId: expected 400, observed 409 due to insufficient
stock. The generated validator checks requestId.length, not trimmed content.
Later probe checks were NOT reached and are not claimed as passed.

The API-only diagnostic reproduced the same failure on unchanged artifacts:
`docs/evidence/bot-transfers-independent-diagnostic.json`.
Archive: `output/verification/bot-transfers-initial-20261019/`, including source,
contract, report and screenshots. No generated source was manually repaired.

The probe interprets the requested nonempty identifier as excluding whitespace
only; future acceptance criteria should spell this out explicitly. The general
coverage gap remains: the completion gate executes browser scenarios but does
not currently execute independent direct-API invalid-input/concurrency checks.
This trial must not be relabelled an autonomous success after later repairs.

Installed runtime when launched:
`123E44EFB259F26000C3EE439023442E07905621069EC25E4AFC31A932BA1CCA`.
