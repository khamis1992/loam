# Independent author instruction conflict

Real recovery task_mveumcvtdbf76a7e226c passed its baseline: 14 functional checks
and all 14 screenshots in two visual batches, 154785 ms. Authoring then failed at
06:24:47Z because the independent model returned more than four scenarios.
No independent execution or external holdout occurred; no completion was sent.
Observer 52180 exited 1; recovery observation 205614 ms. Report remains failed.
Archive: output/verification/bot-tickets-independent-limit-failure-20261019.

Inspection found conflicting instructions: shared worker documentation allowed
1–12 scenarios and told the author to preserve existing regression scenarios,
while independent acceptance allows only 1–4. The user supplied seven baseline
scenarios. This is a plausible contributing cause, not proof of model reasoning.

Independent author now receives shared executable schema with its own 1–4 limit,
without worker file-delivery/baseline-freeze instructions. A final instruction
explains that the entire baseline still executes separately. No truncation,
schema relaxation, arbitrary content retry or frozen-contract replacement was
introduced. A five-scenario response still fails in one call. Fixture tests for
prompt scope, rejection, immutable contracts, source integrity and actual browser
negative controls pass (3456 exit 0). Full verification/build is running (40922).

Full verification and build passed (40922 exit 0). Installed both this instruction
fix and the cloud completion guard at 09:29:25 Riyadh after idle checks.
Runtime SHA256: 8A2C2E6535316FFD484DD1DC90DE7E89D5A20A6833101D72B42564BEB7D988D2.
Installer evidence: output/verification/bot-install-20261019-092918/verification.json;
profile and all 148 tasks preserved. Both original and recovery failures remain
authoritative. Previous candidate A6C4... was superseded before installation.

Resumed the same task after confirming recovery.resumable=true and
requiresConfirmation=false. Observer 51631 writes the separate report
bot-installed-tickets-fresh-full-gate-1792391378865.json. This is a recovery on a
new build, not a fresh first-attempt success. No generated source was edited.
