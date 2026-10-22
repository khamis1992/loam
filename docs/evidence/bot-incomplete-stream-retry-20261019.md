# Bounded recovery for incomplete model transport

Recovery observer 51631 ended with error. Task task_mveumcvtdbf76a7e226c passed
all 14 functional checks; only 12/14 screenshots received completed visual
reviews. The remaining batch exhausted two attempts, the last ending with an
incomplete Ollama stream. Baseline elapsed 225922 ms. Report:
.verification/f6cef839-7ae5-4729-9553-68b5497e1ada/report.json in the task workspace.
Original recovery evidence bot-installed-tickets-fresh-full-gate-1792391378865.json
remains failed. Author instruction fix was not reached in this recovery.

The adapters already reject incomplete output. They now throw a typed
IncompleteModelStream error so visual review and independent author transport
handling can retry a first incomplete response once. Same model/messages/images,
same author three-minute deadline and same application five-minute deadline.
Maximum two attempts unchanged; semantic verdicts and malformed JSON are not
retried. This would NOT make the previous exhausted two-attempt run pass.

Real HTTP local/cloud adapter tests assert typed errors. Retry tests exercise both
providers, identical inputs and signal/budget retention, persistent transport
failure, semantic rejection and malformed response handling. Focused checks passed
(47507 exit 0). Added check:bot-visual to mandatory runtime suite. Full verification
and build passed (22997 exit 0). Installed at 09:41:40 Riyadh, runtime hash
F4E5E821E745849826EC5A63484A195825D1FC1517900DB6306E33F3A0D22088.
Installation evidence output/verification/bot-install-20261019-094133/verification.json
confirms profile and all 148 tasks preserved.

Separate real-author diagnostic (63168) timed out after its bounded author budget;
no contract or execution was accepted. Source hashes stayed identical. Report
bot-independent-artifact-live-task_mveumcvtdbf76a7e226c-1792391843889.json.
Tiny actual text transport probes then completed in 1219 ms (glm-5.3-flash:cloud)
and 3892 ms (glm-5.2:cloud); report bot-model-health-1792392071095.json. This rules
out complete service unavailability at that moment, not intermittent failures or
long-request latency. No user model settings were changed. No world-class claim.

After installation and transport health probes, resumed the original stopped
task without source edits. Current observer 9434 writes
bot-installed-tickets-fresh-full-gate-1792392121105.json. Previous observers are
terminal; this report must independently pass before any filter continuation.
Do not replace previous failures or call recovery a first-pass success.
