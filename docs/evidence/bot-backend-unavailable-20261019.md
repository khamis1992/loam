# Backend verification environment failure

The installed ticket task ended in error when the Docker engine pipe was absent.
Previously, this verification failure could consume a code repair attempt even
though no application defect had been demonstrated.

BackendSandbox now classifies failures of the fixed local-image preflight as
BackendUnavailable. Application verification propagates that distinction to
the final verifier. Direct and planned execution stop without final delivery
or a repair worker when verification is unavailable. Source validation and
application startup errors still follow normal defect handling. Docker failure
after preflight is not covered by this classification yet.

The regression test removes Docker discovery only within its own process. It
checks both execution paths, absence of completion and repair events, unchanged
source, and preservation of the planned final repair allowance and checkpoint.
It is now included in npm run verify. It uses a fixture model, not a live-model
task, and does not certify general agent performance.

Validation: npm run verify passed; check-cloud-model.ts passed; server build
passed. The cloud-model test needed an explicit assertion that its first tool
call exists to satisfy TypeScript's indexed-access checking.

Installed runtime SHA256:
F3D8E496AC19BE38429AC3B0AA0493FF63733FD43FFDCF7B283E6924851786C2.
Installation report: output/verification/bot-install-20261019-070419/verification.json.
Profile and 144 tasks preserved. Capability revision remains 9, version 0.5.25.
Verification log: output/verification/bot-unavailable-verify-20261019.log.

Docker was stopped with its supported force-stop command. Removing the stale
sailor-ingest.sock failed with Windows error 1920. The stopped Docker temporary
run directory was preserved by renaming it to run-stale-bot-20261019-070437,
and Desktop was restarted hidden. No Docker images, volumes or data directories
were removed. Engine readiness and the live ticket trial still need checking.

Follow-up: the new run directory was created successfully. Desktop now fails
at a different stale socket: LocalAppData/docker-secrets-engine/engine.sock,
with the same Windows error 1920 during rename to .stale. This is confirmed in
the backend log at 04:04:41Z. No changes to the secrets-engine directory have
been made. Docker readiness probe session 93188 was still waiting at the last
poll; do not infer readiness from Desktop processes or restart the ticket yet.

Resolved 04:07Z: docker-secrets-engine contained only engine.sock and
engine.sock.stale. After stopping Docker, it was preserved as
docker-secrets-engine-stale-bot-20261019-070611. The first restart encountered
a newly stale ingest socket left by the previous failed startup. Docker was
stopped again and run preserved as run-stale-bot-20261019-070653; the secrets
socket directory was still absent. Starting with BOTH directories absent
succeeded. docker info returned 29.8.0, and the existing Node image inspected
successfully. No factory reset, volume deletion or image pull was used.
The ticket trial has now resumed under observer 3559; its earlier failure
report remains preserved separately. This supersedes the previous readiness
warning, not the historical trial failure.
