# Installed independent quote trial — passed

Task task_mvetmq5qd3a4fb8b48a1, observer 71141 exit 0, elapsed 1190854 ms
(19m50.854s including the external probe). No supplied acceptance contract and
no operator edits to generated sources. Installed runtime hash remained
954ed18e933b22558fb42b677145ac273de8b593dd484f76b5cd7cdfa4865c3c throughout.

- Baseline: eight scenarios across desktop/mobile = 16 passing checks.
- Independent author: four scenarios across desktop/mobile = 8 passing checks:
  multi-item UI calculation, exact API success/rejection behavior, server duplicate
  SKU rejection displayed in UI, deletion/recalculation/empty-list behavior.
- Both reports pass and match source hashes before final verification/delivery.
- External held-out probe: 15 requests passed, covering mixed prices, half-cent
  rounding, invalid inputs/types/duplicates/cap/malformed JSON and recovery after
  invalid requests. No final repair events were recorded in this fresh trial.

Raw result: bot-independent-installed-quote-selector-fix.json. Durable archive:
output/verification/bot-quote-selector-fix-pass-20261019 (source and both report
sets/screenshots). Prior format failure, author timeout and failed resumed trial
remain failures. This changed-build diagnostic success does not establish an
unbiased success rate or reference-agent parity.

Visual limit of the runtime used in this trial: baseline captured 16 images but
only first 12 were sent to vision; independent captured/reviewed all 8. Do not
claim all 24 captures were visually reviewed in this original run. New installed
runtime D4678427... corrects that limit; separate real-model full-coverage check
on these unchanged files is running as 12893. It is not part of this trial's
original timing or autonomous result.
