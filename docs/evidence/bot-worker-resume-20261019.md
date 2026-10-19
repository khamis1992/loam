# Worker tool-batch recovery improvement

The worker now persists its transcript, tool evidence, step count, model and
known usage after a completed tool batch. An interrupted orchestrated step
with a matching worker prompt resumes from this transcript rather than a new
worker conversation. The old safe boundary is invalidated before new tool
effects begin. Task completion still goes through the final verifier.

Validation on 2026-10-19:
- `check-bot-worker-resume.ts`: retained results, unchanged effect count,
  accounting, exhausted budget, mismatched task rejection and boundary
  invalidation before new effects passed.
- `npm run check:recovery:http`: actual isolated HTTP server process kill and
  restart before and after the second append passed. In the after-effect
  case, the interrupted step now appends once, where the previous baseline
  appended twice after explicit retry. Model responses remain fixtures.
- `npm run verify`: all checks passed, including 114 orchestrator assertions.
- After the final adjustment preserving the restored in-flight flag during
  startup, `check-recovery-http.ts --bundle --after-effect` passed on the built
  artifact. Evidence workspace: `C:/Users/khamis/AppData/Local/Temp/manus-http-recovery-ugMBPE`.

Installed runtime SHA256:
`1E71928ED70D22EEF63F315575368C0A6EFAC8D8C0BDFD8EEF3A59C2ED1E9746`.
Installer report: `output/verification/bot-install-20261019-042157/verification.json`.
The original profile and 142 tasks were preserved. Version remains 0.5.25.

Limitations: this is recovery at completed tool-batch boundaries, not
exactly-once external effects. Crashes inside a batch or between effect and
checkpoint remain uncertain and require explicit retry confirmation.
Changed worker prompts (including repair/replan prompts) do not reuse a
nonmatching transcript. Direct non-orchestrated workers do not gain persisted
resume through this change. Live-model interrupted-task trials and generic
effect reconciliation remain outstanding. Saved context does not prevent a
model deliberately requesting an already completed action again.
