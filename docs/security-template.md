# Template injection verification — revision 55

Campaign assessments accept `template`, an explicit list of up to five template-injection cases. Each case declares:

- `syntax` — one of three common template syntaxes: `mustache` (`{{...}}`), `dollar` (`${...}`) or `erb` (`<%= ... %>`);
- `method` — `get` (query parameter) or `post` (one declared top-level JSON field; the path must be allowlisted in `postPaths`);
- `path` and `field` — one exact in-scope path and a safe field or parameter name;
- `baselineRef` — a benign baseline value, fresh per run through `businessSecrets`, never recorded, digest-pinned in the campaign witnesses, and validated to contain neither computed witness.

Execution model (`src/security/template-injection.ts`, run after the upload engine): the canary is a **harmless arithmetic expression** rendered in the declared syntax. Two distinct expressions — `7*6` (witness `42`) and `7*7` (witness `49`) — distinguish real evaluation from coincidence or static echo. Four requests per case:

1. **Baseline** — the benign value must succeed; the response must contain **neither** witness (negative control; a page that already shows 42 or 49 cannot ground the differential).
2. **Truth probe** — `7*6` in the declared syntax; evaluation is proven only if `42` appears.
3. **Falsy probe** — `7*7`; evaluation is proven only if `49` appears.
4. **Stability repeat** — the baseline again; its full signature must match the first (volatile responses are inconclusive).

Verdict rules:

- `observed` — stable clean baseline, and **both** expressions were evaluated (`42` and `49` both present in their respective responses). Emits a `template_<case-hash>` finding (high). Two distinct computed outputs rule out coincidence; a static echo returns the raw canary instead. Only inert arithmetic is submitted — no data access, no side effects, no engine-specific objects.
- `not_observed` — the canary was echoed back verbatim (treated as data, not template source) or neither expression was evaluated (encoded, rejected or normalized).
- `inconclusive` — the baseline failed, already contained a witness, was unstable, or the case did not complete. Inconclusive cases mark the run `partial` via a `template_coverage` error finding and prove nothing either way.

Evidence: query strings are stripped from recorded evidence URLs; POST bodies are stored as sizes and hashes only; the baseline value never appears in stored output. Retests preserve the case list and demand a fresh baseline digestting to the baseline, so a repair that renders user input as data can move findings to `notObserved`. The diagnostics module `template` reports planned/conclusive/inconclusive counts.

Honest limits:

- Command injection (shell metacharacters, OS-specific canaries) is a separate concern and is **not** covered by this engine; sandbox escapes of specific template engines (Freemarker/Velocity class access, Jinja SSTI chains) are not probed beyond the three arithmetic syntaxes.
- A clean case proves these two expressions were not evaluated for this field and input — not general template safety; engines with custom delimiters need separate operator-declared syntaxes, which this engine does not yet accept.
- Responses larger than 32 KiB are treated as inconclusive for that probe.

Validation: `npm run check:security-template` runs a real local HTTP fixture: (a) a compiling handler evaluating both expressions in mustache syntax (observed, controls recorded), (b) the same endpoint in dollar syntax (observed), (c) a data-only render echoing the canaries raw (not_observed with `payloadEchoedRaw` recorded), (d) a failing endpoint left inconclusive, plus validation rejections (quick profile, unknown syntax, query-bearing path, unsafe field name, baseline containing a witness, missing fresh baseline), eight-probe evidence accounting for the two vulnerable cases, baseline redaction, diagnostics accounting, and a repaired retest (render as data) closing both findings through `notObserved`. All 28 `check:security*` gates, typecheck for the touched modules and `check:encoding` pass. Worktree-only; not yet in an installed release.
