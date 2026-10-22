# Coding eval baseline

Recorded 2026-10-22T18:27:58.876Z in `self-check` mode.

- pass@1: 100.0%
- passed: 20/20
- failed: 0
- errors: 0
- skipped: 0
- duration: 6989ms

## Per task

| task | category | status | steps | duration |
| --- | --- | --- | --- | --- |
| task-001 | bug-fix | pass | - | 106ms |
| task-002 | bug-fix | pass | - | 116ms |
| task-003 | refactor | pass | - | 96ms |
| task-004 | refactor | pass | - | 110ms |
| task-005 | add-test | pass | - | 265ms |
| task-006 | bug-fix | pass | - | 83ms |
| task-007 | refactor | pass | - | 75ms |
| task-008 | add-test | pass | - | 194ms |
| task-009 | bug-fix | pass | - | 112ms |
| task-010 | refactor | pass | - | 119ms |
| task-011 | bug-fix | pass | - | 316ms |
| task-012 | refactor | pass | - | 176ms |
| task-013 | add-test | pass | - | 697ms |
| task-014 | bug-fix | pass | - | 400ms |
| task-015 | refactor | pass | - | 343ms |
| task-016 | add-test | pass | - | 1856ms |
| task-017 | bug-fix | pass | - | 222ms |
| task-018 | refactor | pass | - | 232ms |
| task-019 | add-test | pass | - | 1269ms |
| task-020 | bug-fix | pass | - | 196ms |

## Notes

`self-check` applies each fixture's reference solution, so pass@1=100% means every
fixture and its hidden test agree. `baseline` runs the untouched tree and inverts the
verdict, so pass@1=100% there means every hidden test actually fails without a fix.
The `agent` mode is the real benchmark; it is only meaningful when a model is reachable.

## Model reachability

At recording time no model was reachable in this environment: no API keys were
configured and no local Ollama server answered, so the real-agent baseline could
not be captured within the recording budget. The committed baseline is therefore
the offline `self-check` result. To capture the real benchmark, run:

```bash
npm run eval:coding -- --mode=agent --record-baseline
```
