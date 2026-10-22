# Isolated code-function evaluation

UPDATE 09:00 Riyadh: full real-model suite **42448 exit 0**. Generated invoice
function passed the four isolated behavioral checks; Arabic CSV exact output and
missing-file false-completion rejection also passed. Unique report
`bot-verification-live-1792389542589.json`; archived outputs in
`output/verification/bot-non-ui-live-20261019`. This is source-runtime evaluation,
not an installed HTTP trial, and does not retroactively change earlier evidence.

Prepared the existing real-model non-UI evaluation for broader follow-up runs.
Previously check-bot-verification-live.ts imported generated invoice.mjs into the
host test process. It now copies that module into a fresh probe workspace and
loads it only inside BackendSandbox's offline Docker container. A fixed HTTP
probe records the same four behavioral checks: empty input, total/rounding,
negative quantity and negative price. The host checks exact returned JSON.

Real Docker fixture test passed for a correct module and rejected a module that
returns zero instead of throwing RangeError. Typecheck passed (71502 exit 0).
Script: src/scripts/check-invoice-behavior-probe.ts. This fixture result does not
claim a new real-model success. Existing historical model evidence is unchanged.
Future real-model reports use unique timestamped filenames rather than replacing
bot-verification-live.json. No installed runtime change is needed for this
evaluation-only improvement.

Run the broader real-model suite after the current installed quote trial is
terminal to avoid overlapping provider load. Preserve all failures, and treat
this as source-runtime evaluation unless explicitly run through installed APIs.
