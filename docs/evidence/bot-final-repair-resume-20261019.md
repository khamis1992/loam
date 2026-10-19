# Final-repair recovery fix

Previously, a checkpoint interrupted during the final repair retained
`finalRepairUsed=true` but did not retain an explicit pending repair phase.
Resume could review the stale answer and reject further work because the
repair allowance had already been used, leaving saved worker results unused.

The checkpoint now retains `finalRepairPrompt`. Resume continues that same
repair before final verification. A matching saved worker transcript keeps
completed tool results; successful repair clears the pending instruction.
Fresh verification is mandatory and a repeated rejection still fails.

Validation on 2026-10-19:
- `check-bot-final-repair-resume.ts`: interrupted before the repair tool,
  interrupted after its saved result, and rejected post-resume verdict.
  Each case checked actual append-only file bytes. Successful cases also
  checked accounting and verification before final delivery. Rejection did
  not produce assistant_message/done. These use fixture model responses and
  an abort at the persisted checkpoint, not a live-model crash trial.
- `npm run verify`: passed, including 114 orchestrator assertions.
- `npm run check:recovery:http`: passed worker-boundary, final-repair and
  actual server kill/restart tests.
- `check-recovery-http.ts --bundle --after-effect`: passed on the built server.

Installed SHA256:
`123E44EFB259F26000C3EE439023442E07905621069EC25E4AFC31A932BA1CCA`.
Installer report: `output/verification/bot-install-20261019-042655/verification.json`.
Original profile and 142 tasks preserved; version 0.5.25.

This fixes new checkpoints carrying the pending instruction. Older final
repair checkpoints without that instruction are not retroactively migrated.
Mid-tool uncertain effects, live-model final-repair interruption and broader
cross-domain reliability remain outstanding; this is not a world-class parity
claim.
