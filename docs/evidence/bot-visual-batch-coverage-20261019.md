# Complete captured-screenshot review (pending installation)

UPDATE 08:56 Riyadh: installed D4678427... after successful trial and idle queue.
Profile and 147 tasks preserved; installer report
output/verification/bot-install-20261019-085614/verification.json.
Full real-model unchanged-artifact diagnostic is running as **12893**. Earlier
pending-install notes below are historical; diagnostic success remains pending.

UPDATE 08:58 Riyadh: diagnostic **12893 exit 0**, all **16 screenshots** reviewed
in **2 real-model batches**, 114951 ms; all checks pass and source hashes before/
after match. Evidence `bot-full-visual-live-task_mvetmq5qd3a4fb8b48a1-1792389392264.json`.
Archive `output/verification/bot-quote-full-visual-pass-20261019` contains the
report/screenshots and evidence. This is a separate unchanged-artifact diagnostic,
not an extension of the original autonomous trial's success/timing.

Audit found application verification used `screenshots.slice(0,12)`. With eight
scenarios, the runtime captures sixteen images in desktop-first order, so four
mobile images never reached the visual model. With twelve scenarios, no mobile
image reached it. Functional checks still ran on both viewports, but that does
not establish visual review of every captured state. Prior evidence must retain
this limitation; do not retroactively claim all old screenshots were reviewed.

Changed review to sequential batches of at most twelve images, under the same
overall runtime deadline. Every batch must return a valid passing verdict. A
later rejection/unavailability blocks completion, all returned usage is summed,
and reports identify each batch, reviewed image paths and complete=true only
after all images are reviewed successfully. No silent sampling/fallback.
Installed capability will advertise visualReviewCoverage.allCapturedScreenshots;
the future installed quote runner checks exact screenshot-list equality when
that capability is present.

Actual-browser fixture test: seven scenarios produce fourteen captures. All
fourteen reviewed exactly once on success; a rejection of mobile-6.png blocks
success; transient unavailability of the second batch is retried only as allowed
and still blocks completion. Usage from completed batches is retained.
Vision judgments in this test are fixtures, not a live model quality result.
Script: src/scripts/check-bot-visual-batches.ts (mandatory in npm run verify).
Standalone test and typecheck passed (19521 exit 0).

Full verify/build **33895 exit 0**; log
output/verification/bot-visual-batches-20261019.log. Do not install while quote
task task_mvetmq5qd3a4fb8b48a1 / observer 71141 remains active. It uses the old
installed screenshot limit. After terminal outcome, preserve its evidence,
install the verified build and independently rerun full visual coverage on a
stable generated artifact without changing its source; label that diagnostic
separately from autonomous generation.

Verified candidate hash:
**D4678427CDD9CB657159F1073DFB6CF486293882578EB0031312D2CC6C79F00B**.
Prepared `src/scripts/check-bot-full-visual-live.ts <taskId>`; requires terminal
task and idle queue plus installed full-coverage capability, retains actual
source hashes and unique output, and requires more than twelve reviewed images.
Typecheck passed. Do not run until the active installed evaluation finishes.
