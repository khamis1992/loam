# Open redirect verification — revision 59

Campaign assessments accept `redirect`, an explicit list of up to five open-redirect cases. Each case declares:

- `path` and `param` — one exact in-scope GET endpoint and its redirect parameter;
- `safeTargetRef` — a benign in-origin target path (must start with a single `/`), fresh per run through `businessSecrets`, never recorded, digest-pinned in the campaign witnesses;
- `foreignOriginRef` — an inert https origin base (validated syntax; **never contacted**).

Execution model (`src/security/redirect.ts`, run after the command engine): redirects are **never followed** — the `Location` header alone is the witness, so the probe destination is never contacted and no external host is ever reached. Per case:

1. **Positive control** — the benign in-origin target must produce a 3xx whose `Location` stays inside the application origin (relative or same-origin absolute). This proves the endpoint redirects based on the declared parameter.
2. **Probe** — a fresh foreign URL of the form `<foreignOrigin>/loam<random-token>` is submitted through the parameter. The verdict fires only when the `Location` passes that exact URL through verbatim.

Verdict rules:

- `observed` — the control held and the Location carried the tokenized foreign URL unchanged. Emits a `redirect_<case-hash>` finding (medium): user-controlled open redirect to a foreign origin — phishing/credential-redirection and OAuth-flow abuse, not direct compromise. The foreign base is an operator-declared inert origin and was never contacted.
- `not_observed` — the redirect normalized or rejected the foreign URL (Location stayed in-origin, e.g. an allowlist fallback), or the probe produced no redirect at all.
- `inconclusive` — the benign control did not produce an in-origin redirect (bad endpoint, parameter or target), or the case did not complete. Inconclusive cases mark the run `partial` via a `redirect_coverage` error finding and prove nothing either way.

Evidence: query strings are stripped from recorded evidence URLs and the tokenized foreign URL never appears in stored output; the proof records statuses and the two witness booleans. Retests preserve the case list and demand fresh values digestting to the baseline, so an allowlist repair can move the finding to `notObserved`. The diagnostics module `redirect` reports planned/conclusive/inconclusive counts.

Honest limits:

- One declared parameter per case; redirects through POST bodies, headers, Referer-based fallbacks and client-side `location` assignments in SPA scripts are not covered.
- Scheme-relative (`//host`), backslash and encoded-variant bypasses are separate operator declarations (the probe tests the exact absolute-URL form only); a clean case proves this URL form was not passed through, not general redirect safety.

Validation: `npm run check:security-redirect` runs a real local HTTP fixture: (a) a raw pass-through handler putting the tokenized foreign URL into `Location` verbatim (observed with the in-origin control recorded), (b) an allowlisted handler normalizing the foreign URL back to the home path (not_observed), (c) a failing endpoint left inconclusive by the broken control, plus validation rejections (quick profile, query-bearing path, unsafe parameter name, non-path safe target, non-https foreign origin, missing fresh values), two-request evidence accounting, the never-recorded tokenized-URL invariant, diagnostics accounting, and a repaired retest (allowlist) closing the finding through `notObserved`. All 32 `check:security*` gates, typecheck for the touched modules and `check:encoding` pass. Worktree-only; not yet in an installed release.
