# Mandatory independent application gate — installed, live evaluation pending

UPDATE 04:49Z: installed revision 11, hash
FA0A2BC9E4E5BB8F2D8DDAA39F34440A0E3ED1704BD934E66AD2F1F8751F1585.
Installer preserved profile and 144 tasks; report:
output/verification/bot-install-20261019-074900/verification.json.
Full verify/build passed (1088 exit 0), log bot-independent-release-verify-20261019.log.
Additional tests passed (72140 exit 0): unresolved independent defect never
completes after repair allowance, and external mutation between baseline and
independent execution blocks that result until both rerun against matching files.
All older not-installed statements below are historical and superseded.

Installed live task task_mveryqid82ce51d1d69f is running, observer 57338.
Script: src/scripts/check-bot-independent-installed.ts.
Evidence: docs/evidence/bot-independent-installed-quote.json.
Spec: docs/evidence/bot-independent-quote-spec.json.
Task: Arabic RTL quote calculator with exact integer-cent arithmetic, discount
rounding, shipping exclusion from discount and strict API validation. NO supplied
acceptance contract. Require both baseline and runtime-owned independent report
passes before final delivery, matching source hashes, real visual judgments,
file-only tools and an additional independent API holdout. Holdout covers mixed
items, half-cent rounding, invalid types/null, empty/duplicate SKUs, quantity
bounds, subtotal cap, malformed JSON and successful request after rejections.
Do not claim pass before observer completion. Do not restart an active task just
because observation times out; inspect its persisted state and reattach instead.

verifyFinal now runs both the worker/user baseline and an additional runtime-owned
independently authored contract before final text judgment. Both functional and
visual results are supplied to final judgment. Independent rejection blocks final
delivery and supplies its frozen checks to repair; unavailable authoring blocks
completion without spending code repair. Known usage is accumulated, including
baseline/author usage persisted at the snapshot boundary before interruption.

Direct execution retains one IndependentAcceptanceGuard for retries. Planned
execution persists independentAcceptance and independentRequirements with its
ExecutionCheckpoint before running the independent tests. Resume reuses those
checks, never reauthors them. A fresh execution gets a fresh guard. Requirements
include only prior user messages plus the latest user request, with the latest
explicitly taking precedence. Assistant/tool content is excluded. Requests over
the author limit fail closed; no automatic lossy trimming is introduced.

Source hashes from both passes must match. Tests cannot certify different source
versions in the two phases. Baseline tests are still required and cannot be
replaced by the low-level independent-contract override.

Validation:
- check-bot-independent-gate.ts passed direct, planned, trivial, interrupted
  snapshot/resume and author-unavailable paths (90957 exit 0). A deliberately
  weak baseline passes a broken counter; independent checks block it, repair
  fixes the implementation, exactly one author call occurs, no premature final
  answer appears, persisted snapshots remain, and usage equals actual calls.
- Existing check:bot-apps passed (60136 exit 0). Its model fixtures now return
  a valid independent contract; the missing-finalAnswer test additionally checks
  the actual rejection reason to avoid passing for the wrong reason.
- Full verify passed after the cross-pass source-hash typing adjustment
  (73249 exit 0), log bot-independent-integrated-verify-20261019.log.
  All test observers from this implementation round are terminal.

No build/install or installed real-model task has run with this integrated gate.
Installed runtime remains revision 10, hash
3EAF4024E51A94DC986835CFEA6F402E0F8419B880DAFC2ABE588877C72AAFA1.
The installed independentlyAuthored flag correctly remains false. Do not change
that claim based on source-only tests. Previous standalone real-model author
experiment is not a substitute for an installed task using this mandatory gate.

Next: verify final regression status, add explicit cross-pass source mutation and
persistent rejection coverage, update capability/installer checks, build/install
when idle, and run a real task without supplying its acceptance contract. Require
both report sets, frozen checkpoint, no premature completion, and a separate
holdout probe. Also check JSON/schema failures and source bounds remain closed.
Do not claim broad independent test quality from one counter fixture.
