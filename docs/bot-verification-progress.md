# BOT mandatory outcome verification

Implemented 2026-10-19 (Asia/Riyadh). This milestone is not a claim of frontier-level reliability.

Follow-up: application runtime/visual verification and installed revision 2 are tracked in `bot-frontier-goal.md`, including real-model evidence and the remaining full-goal requirements.

## Completion contract

- All orchestrated plans, including trivial plans and planner fallbacks, pass step critique and final verification. The legacy `verifyFinal: false` setting cannot disable the gate.
- Direct agent runs also verify their candidate answer. They get one repair opportunity; unavailable, invalid, or unsuccessful verification blocks completion.
- Candidate final text is buffered. No assistant answer or completion event is published before acceptance. Step completion events follow accepted critique.
- Server persistence additionally requires `result.verified === true` before `completeTaskRun`.
- Checkpoint resume rechecks the final result without replaying completed steps, including older completed checkpoints.
- The verifier can independently inspect files, device files, browser snapshots and task state through an explicit read-only capability list. Shell, browser JavaScript, write tools and hooks are unavailable to this role. On tool-using runs with inspection capabilities, a model PASS without a successful inspection is rejected.
- Full tool evidence is collected separately from short UI summaries. Final verification receives the full user request and candidate final answer.

## Validation

- `npm run check:orchestrator`: 88/88. Includes planner fallback, trivial/direct execution, disabled verification setting, no premature answer, missing inspection, failed read, forbidden write, recovery, and repair paths.
- `npm run check:recovery:http`: actual server process restart/resume, no repeated effects, and failed verification persisting as error without an assistant success answer.
- `npm run typecheck`, `npm run check:encoding`, and `npm run build:server`: passed. The HTTP recovery/verification test also passed against the built `dist/server.cjs` using `--bundle`.
- `npm run check:bot-live`: real `glm-5.3-flash:cloud` model, real filesystem, no stub model or fake device. Results in `evidence/bot-verification-live.json`.
  - Generated invoice.mjs: read-back verification before completion; four independent behavioral assertions after the agent run passed (empty array, calculation/rounding, negative quantity, negative price).
  - Arabic CSV analysis: generated JSON independently matched totals 220, Riyadh 150, Jeddah 70, four rows.
  - False claim that a missing report exists: real verifier refused PASS.
- The first live run correctly refused completion but exposed truncated evidence (only the first ten lines reached the critic). Fixed by separating internal evidence from UI summaries; the second run passed all three cases.

## Remaining limits

- A successful inspection is necessary but not sufficient for semantic correctness. The model still judges whether observations satisfy the request. This is not a formal proof and can produce false rejection or false acceptance.
- Independent behavioral assertions in the live harness run after completion; they are external grading, not a general in-product test runner. Mandatory executable acceptance contracts for code, visual inspection for graphics/3D, and service-specific validators remain further work.
- Registries without an approved inspection tool use evidence-based model verification. Not every service has a dedicated read-back validator yet.
- Inspection is bounded to five model turns and eight tools per turn; evidence formatting is bounded. Model availability and latency affect completion.
- Other synthetic suites using model stubs that return only plain worker text will need verifier-aware responses; they must not bypass the gate.
- Source changes do not automatically update an already running installed Electron application.
