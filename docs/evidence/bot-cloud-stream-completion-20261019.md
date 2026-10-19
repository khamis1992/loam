# Cloud stream completion guard

Source inspection found that the OpenAI-compatible cloud adapter accepted EOF
without a choice finish marker when any text or tool fragment had arrived.
This could expose a syntactically complete but transport-truncated verdict or
tool call to callers. The local Ollama adapter already rejected this condition.

Changed the cloud adapter to require a choice finish marker regardless of
accumulated content. Transport `[DONE]` alone is insufficient. This does not
certify application correctness: the existing final verification still applies.

Actual local HTTP regression tests now reject empty, partial verdict and partial
tool responses, including streams ending in `[DONE]`. Existing successful text,
fragmented tool, image/history, usage and routing tests pass. Local streaming
regressions and TypeScript typecheck also pass. Added the cloud regression command
to the mandatory BOT runtime suite.

Full `npm run verify` passed (session 3539, exit 0), including independent gate,
selector ambiguity and complete visual-batch failure tests. `npm run build:server`
passed; candidate SHA256 A6C4AB66CD47F8782D389E3A90B62035F58A1475D6670FC988C32732EA5CD67A.
Logs: output/verification/bot-cloud-completion-20261019.log and
output/verification/bot-cloud-completion-build-20261019.log.

The A6C4... candidate was superseded by the independent-author instruction fix.
Both changes were fully verified and installed together at 09:29:25 Riyadh as
8A2C2E6535316FFD484DD1DC90DE7E89D5A20A6833101D72B42564BEB7D988D2.
See output/verification/bot-install-20261019-092918/verification.json (148 tasks
and profile preserved). Original trial evidence still belongs to its old build.
Do not attribute it to installed build D4678427CDD9CB657159F1073DFB6CF486293882578EB0031312D2CC6C79F00B
or the active ticket trial task_mveumcvtdbf76a7e226c. Do not restart that trial.
