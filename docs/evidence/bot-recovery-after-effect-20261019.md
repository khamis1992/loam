# Process interruption recovery — 2026-10-19

Command: `npm run check:recovery:http`.

Both before-effect and after-effect cases passed using isolated real server
processes, actual HTTP routes, actual file writes, persisted task storage and
SIGKILL/restart. Model responses are deterministic fixtures; this is not a
live-model recovery benchmark and does not test the installed desktop process.

Evidence directories:
- Before effect: `C:/Users/khamis/AppData/Local/Temp/manus-http-recovery-MoW28g`
- After effect: `C:/Users/khamis/AppData/Local/Temp/manus-http-recovery-wUwhM9`

The checkpointed first step appends exactly once despite restart. In the
after-effect case, the second append survives a crash before its completion
checkpoint. Resume with missing, false or string-valued replay confirmation
returns HTTP 409 and leaves the task interrupted without another tool call.
Explicit boolean confirmation resumes execution and the second append occurs
again. The test checks the resulting file bytes, not only model/tool counters.

This proves that uncertain effects are gated against unconfirmed replay. It
also proves a remaining limitation: confirmed retry can duplicate an effect
inside an unfinished step. Current recovery is not exactly-once execution.
Operation-specific reconciliation/idempotency and live-model interruption
trials remain necessary. The final-verification rejection control still
prevents persisted done status and assistant answers.
