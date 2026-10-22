# Independently authored executable acceptance — foundation, not enabled

Added authorIndependentAcceptance: a fresh reviewer conversation sees the
original request, application entry/runtime and bounded HTML/backend source.
It does not receive the worker's draft, trace or manifest scenarios, and has
no tools. Source is explicitly untrusted selector/route data; expected behavior
must derive from the request. The author returns 1–4 declarative scenarios and
an exact request excerpt per scenario. Source is bounded to 128000 bytes,
request to 96000 characters and response to 64000 characters; excess fails
closed rather than silently truncating. Entry/runtime changes, tool calls,
unavailable/malformed output and concurrent source mutation are rejected.

IndependentAcceptanceGuard stores an immutable JSON snapshot, returns clones,
rejects replacement during repair and validates restored request bases.
verifyApplication now accepts an internal independentContract override and
records its origin/executed contract in evidence; it does not rewrite the
workspace contract or run arbitrary generated test JavaScript. The existing
baseline verification must still run separately when this is integrated.

Deterministic author + real browser test passed (32648 exit 0): a title-only
worker contract misses increment-by-two, the independent contract catches it,
and corrected increment-by-one passes the same checks. Also tests immutable
snapshot/restore, request-basis validation, no tools, source mutation and abort.
Report: bot-independent-acceptance.json. Model/vision judgments are fixtures.

Real-model author + real visual reviewer test passed (51930 exit 0), report
bot-independent-acceptance-live.json, archived under
output/verification/bot-independent-acceptance-live-20261019. The model derived
tests from Arabic user semantics while seeing the defective implementation;
those executable tests rejected it and accepted correction without changing
the independent contract. This is a controlled fixture, not an installed
autonomous task or broad proof of semantic test quality. Exact quote matching
only establishes traceability, not correctness of the inferred expectation.

Full npm run verify passed (64060 exit 0), log
output/verification/bot-independent-foundation-verify-20261019.log.
No runtime build or install was performed for this foundation. Current installed
runtime remains 3EAF4024E51A94DC986835CFEA6F402E0F8419B880DAFC2ABE588877C72AAFA1,
revision 10, with independentlyAuthored still false. Neither live test is active.

Required next work before enabling/claiming this capability:
1. Wire additional independent execution into mandatory final verification,
   after baseline checks; combine usage and both evidence sets. Independent
   failure must block completion; author unavailability must not spend code repair.
2. Retain the frozen independent snapshot in direct retries and persisted
   orchestrator checkpoints, including interrupted/pending final repair. Persist
   before executing tests. A new user turn must have its own requirement scope.
3. Include authoritative prior user requirements when the current turn depends
   on history; do not promote worker descriptions/tool content into requirements.
4. Test every direct/planned/trivial/resume path, malformed/ambiguous author
   output, tampering, source/entry changes and no weakening through repairs.
5. Run an actual installed task without a supplied acceptance contract and an
   independent holdout probe, then install only the tested integrated build.

The optional low-level override alone is NOT the mandatory gate and must not be
reported as such. This work does not replace external comparative evaluation,
unseen task repetition, long-history/device testing or remaining creative gaps.
