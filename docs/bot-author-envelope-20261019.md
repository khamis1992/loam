# Independent author response envelope

The first fixed-build quote task passed twenty baseline browser checks and visual captures but failed independent authoring with `SyntaxError: "undefined" is not valid JSON`. The parser serialized a missing `response.contract` and passed undefined to contract parsing. No valid independent contract existed, so blocking completion was correct; the diagnostic was misleading.

The author now explicitly rejects non-object envelopes and missing/null/non-object/array contracts before contract parsing, with a specific missing-contract error. The prompt footer repeats the required `{contract,basis}` envelope after the executable schema and preserves the explicit unavailable response. No semantic or malformed-response retry is introduced; contract limits, source integrity and exact request basis validation are unchanged.

Typecheck and the independent acceptance suite passed. New fixtures cover null, array, scalar, empty object, bare contract, verdict object, null/array/string contract; each is rejected after exactly one author call. Valid contracts still execute against actual browser fixtures and detect a defect omitted by the worker baseline.

Full verification/build has been started separately. This source change is not installed, and the running cohort remains on pinned runtime 4CAAED2B99C94E8765988474E663F7CAB636CCCFA144F63DA8065839AB14BB3C. There is no live evidence yet that the prompt clarification prevents malformed provider responses. The prior pending 5AA0E9A... build does not include this change.

Validation update: full `npm run verify` and `npm run build:server` passed; session 57256 exited 0. Log `output/verification/bot-author-envelope-verify.log`. Candidate SHA256 **5E5D5A34F360325890E08594AA7949D09C4193B46D55C076018FDE78B4AA8B94** includes this change and the direct-file search fix. It supersedes pending 5AA0E9A..., but remains uninstalled while cohort session 74938 runs.
