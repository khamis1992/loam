# Path traversal verification — revision 52

Campaign assessments accept `traversal`, an explicit list of up to five path-traversal cases. Each case declares:

- `path` and `param` — one exact in-scope GET file-serving endpoint and its safe query parameter;
- `benignRef` + `benignMarkerRef` — a benign file name served by that endpoint plus a distinctive substring of its content (the positive control's witness);
- `traversalRef` + `markerRef` — the exact traversal payload (for example `../secret/target.txt`) plus a distinctive substring of the target file's expected content (the response witness).

All values are operator-supplied plain strings, fresh per run through `businessSecrets`, never recorded, and digest-pinned in the campaign witnesses for stable retests.

Execution model (`src/security/path-traversal.ts`, run after the injection engines): each case sends **three requests**:

1. **Positive control** — the benign file must be served successfully and contain the benign marker. This proves the endpoint serves files from the declared parameter and that the operator's model of it is correct.
2. **Negative control** — a random nonexistent name must not contain the target marker. This rules out endpoints that echo the marker for any input.
3. **Traversal probe** — the payload must return a successful response containing the target marker for the finding to fire.

Verdict rules:

- `observed` — positive control served, negative control clean, and the traversal payload returned the target marker with a successful status. Emits a `traversal_<case-hash>` finding (high) with all three statuses and control booleans. Only the declared marker is matched; file contents beyond it are never recorded.
- `not_observed` — the controls held but the payload was rejected or returned no marker (blocked, normalized or canonicalized).
- `inconclusive` — the positive control failed (bad endpoint, parameter or benign file), the negative control leaked the marker (echoing endpoint), or the case did not complete. Inconclusive cases mark the run `partial` via a `traversal_coverage` error finding and prove nothing either way.

Evidence: query strings are stripped from recorded evidence URLs, so neither the payload nor any file content appears in stored output; the proof records only statuses and booleans. Retests preserve the case list and demand fresh values digestting to the baseline, so a canonicalization or rejection repair can move the finding to `notObserved`. The diagnostics module `traversal` reports planned/conclusive/inconclusive counts.

Honest limits:

- One declared payload and one declared target marker per case; encoded variants (`%2e%2e%2f`), absolute paths, null bytes, nested segment tricks and multiple parameters are separate operator declarations, not automatic fuzzing.
- A clean case proves this payload was blocked on this endpoint for this encoding, not general file-access safety; authorization on the benign file itself is not verified here.
- GET endpoints only in this revision; POST bodies and header-based path inputs are not covered.

Validation: `npm run check:security-traversal` runs a real local HTTP fixture with real files: (a) a naive `path.join` handler serving the target from outside the root through `../` (observed with both controls recorded), (b) a handler rejecting traversal segments (not_observed at 400), (c) a failing endpoint left inconclusive by the broken positive control, plus validation rejections (quick profile, query-bearing path, unsafe parameter name, missing fresh values), three-probe evidence accounting with query strings stripped, the never-recorded marker and payload invariants, diagnostics accounting, and a repaired retest closing the finding through `notObserved`. All 25 `check:security*` gates, typecheck for the touched modules and `check:encoding` pass. Worktree-only; not yet in an installed release.
