# Dynamic SQL and NoSQL injection verification — revision 51

Campaign assessments accept `injection`, an explicit list of up to five boolean-differential injection cases. Each case declares:

- `kind` — `sql` or `nosql`;
- `method` — `GET` (the value travels in the declared query parameter) or `POST` (the value travels in one declared top-level JSON field; the path must be allowlisted in `postPaths`);
- `path` — one exact in-scope path, and `field` — a safe parameter or field name;
- `baselineRef` — the benign baseline value, supplied fresh per run through `businessSecrets` (plain string, never recorded; digest pinned in the campaign witnesses).

Execution model (`src/security/injection.ts`, wired into the campaign after the business engines): each case sends **four requests** and compares full response signatures (status plus bounded body hash):

1. **Baseline** — the benign value; must be a complete successful response.
2. **Tautology probe** — SQL: `baseline' AND '1'='1`; NoSQL: `{"$eq": baseline}`. A vulnerable engine absorbs the injected boolean, so the signature must equal the baseline exactly.
3. **Contradiction probe** — SQL: `baseline' AND '1'='2`; NoSQL: `{"$eq": <random sentinel>}`. A vulnerable engine changes the answer, so the signature must differ from the baseline.
4. **Stability repeat** — the benign baseline again; its signature must equal the first baseline, ruling out volatile responses before any conclusion.

Verdict rules:

- `observed` — baseline successful and stable, tautology absorbed (identical signature) and contradiction distinguished (different signature). Emits an `injection_<case-hash>` finding (high) with all four statuses and the three control booleans. Only non-destructive boolean differentials are used: no data beyond what the benign query already returns, no state changes, no stacked statements or timing probes.
- `not_observed` — the differential was not established: neither probe changed the response (encoded, rejected or normalized input), the tautology did not reproduce the baseline, or the contradiction did not change it. A clean case proves this differential did not hold for the declared field and value, not general injection safety.
- `inconclusive` — the baseline was not a complete successful response (bad path, field or baseline value) or the case did not complete. Inconclusive cases mark the run `partial` via an `injection_coverage` error finding and prove nothing either way.

Evidence: query strings are stripped from recorded evidence URLs and POST bodies are stored as sizes and hashes, so neither the baseline value nor the payloads appear in stored output; POST probes carry `postPolicy`. Retests preserve the case list and demand a fresh baseline digestting to the baseline, so parameterization or strict-schema repairs can move findings to `notObserved`. The diagnostics module `injection` reports planned/conclusive/inconclusive counts.

Honest limits:

- Boolean differentials only: error-based, time-based, out-of-band and stacked-query techniques are not exercised; a WAF or normalization layer that makes responses uniform will read as not_observed, not as proof of safety.
- One declared field with one operator-supplied baseline value per case; other parameters, headers, cookies and second-order injection points are not covered. NoSQL coverage targets equality-operator object injection in JSON bodies — `$where`, aggregation pipelines and driver-specific operators are not covered.
- The response signature is a bounded-body hash; responses larger than 32 KiB are treated as inconclusive for that probe.

Validation: `npm run check:security-injection` runs a real local HTTP fixture: (a) a naive concatenated SQL lookup where the tautology is absorbed and the contradiction empties the result (observed with all controls recorded), (b) an escaping handler breaking the differential (not_observed), (c) a document-filter handler passing `{"$eq": ...}` objects through (observed), (d) a strict-schema handler rejecting operator objects (not_observed), (e) a failing baseline left inconclusive, plus validation rejections (quick profile, bad kind, POST path outside the allowlist, query-bearing path, missing fresh baseline), four-probe evidence counts for both GET and POST with POST policy, baseline redaction from all stored output, diagnostics accounting, and a repaired retest closing both findings through `notObserved`. All 24 `check:security*` gates, typecheck for the touched modules and `check:encoding` pass. Worktree-only; not yet in an installed release.
