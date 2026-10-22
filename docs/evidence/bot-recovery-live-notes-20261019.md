# Real-model recovery trial

`npx tsx src/scripts/check-bot-recovery-live.ts` passed on 2026-10-19.
Report: `docs/evidence/bot-recovery-live.json`.
Durable event/result copies: `output/verification/bot-recovery-live-20261019/`.

The configured real model planned four steps. A child process executed a real
append to an isolated file ledger and exited with code 77 immediately after
persisting the worker tool-batch checkpoint. A new child process loaded that
checkpoint and continued with the real model. No synthetic model responses or
deduplication were used. The append-only tool would append every repeated call.

The final ledger exactly matched the pre-resume bytes: original entry 125,
new entry 75, two distinct identifiers and total 200. The final verifier read
the actual ledger and passed before assistant_message/done. The run reported
16 execution steps including orchestration, and the independent harness
checked both file contents and event ordering. Type checking passed.

Scope: a short live-model orchestration recovery trial with constrained local
file tools, not a desktop HTTP recovery benchmark or a long-running workload.
The previous HTTP/process tests cover the HTTP layer with fixture models.
This trial terminates after a completed durable batch, not during an external
effect. Mid-batch crashes and general effect reconciliation remain unproven.
No additional production changes or installation were needed for this trial;
the previously installed worker-checkpoint runtime remains current.
