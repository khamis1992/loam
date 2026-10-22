# Installed transfer repair trial — passed

Started 2026-10-19T01:45:06Z using the SAME task
`task_mvekt3qa69bbc61f4011`, on installed capability revision 8.
Observer exec session **16168** finished with exit 0. Do not poll it again.
The earlier initial-trial observer 18630 is terminal (failed).

Command: `npx tsx src/scripts/check-bot-installed-transfers.ts --repair`.
Spec: `docs/evidence/bot-transfers-repair-spec.json`.
Evidence: `docs/evidence/bot-installed-transfers-repair-live.json`.

The explicit user continuation clarifies rejection of whitespace-only IDs
(including tabs/newlines), preserving valid identifiers and idempotency.
All seven original scenarios are retained exactly; three added scenarios
cover invalid API inputs/malformed JSON, concurrent identical replay with
insufficient remaining stock, and concurrent competing transfers. Ten
scenarios imply 20 viewport checks, each with SQLite assertions; API groups
are checked against actual report observations as well as success status.
Independent original API probe runs afterward, including reverse transfer.

Spec parsing and TypeScript passed. No product/generated app edits were made
by the engineering agent for this repair; BOT performs application changes.
Final status: persisted done with all checks below passed:
- 20 actual browser scenario/viewport checks; real visual model verdict pass.
- 26 direct API observations matched expected groups/statuses and paths.
- SQLite states matched every declared scenario; original seven scenarios
  remained unchanged and the explicit enhanced contract matched exactly.
- Final verify pass preceded assistant_message/done; no premature streamed
  assistant tokens; only file tools were used by the executor.
- Independent fresh-sandbox API probe passed duplicate concurrent requests,
  retry after insufficient remaining stock, conflicting request identities,
  competing transfers, invalid quantities/fields, malformed JSON, reverse
  transfer, and exact two-table final contents (A=5/B=5/C=0, three transfers).

Elapsed 462605 ms (7m43s), reported execution steps 42. Combined with the
initial failed trial: 1014691 ms (~16m55s) active execution across two rounds,
excluding engineering work between rounds; not one uninterrupted task run.
Archive: `output/verification/bot-transfers-repair-20261019/`.
Application report: `a5a04a39-706f-4fea-8513-f7910326270b`.
Installed runtime remained capability revision 8 / SHA256
`13E0668D50BB4F6E56B4046FFABBACD5D646F99CCD46AC4D6D9F5F754B7D0296`.

No installed product changes were needed in this trial; BOT changed its task
application. Scope remains a single ephemeral backend per scenario/probe,
not storage durability after container deletion or broad agent parity.
The initial trial remains failed regardless of this continuation outcome.
