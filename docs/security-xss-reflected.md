# Reflected cross-site scripting verification — revision 48

Browser-enabled campaigns accept `browser.xssReflected`, an explicit list of up to ten reflected-XSS cases. Each case declares:

- `path` — one exact in-scope path (no query or fragment);
- `param` — the query parameter name that reaches the response (letters, digits, `_`/`-`, up to 64 characters; action-like names are rejected);
- `id` — a unique case identifier.

Execution model (`src/security/xss-reflected.ts` + the browser engine in `src/security/browser.ts`): for every case the isolated browser first loads the declared path **without any canary** — the baseline control must render a successful document at the requested route and carry no trace of the fresh per-run marker. Only then does the engine navigate to the same path with the canary URL-encoded into the declared parameter and observe the rendered result. The canary is `"><img src=x onerror="...">` whose handler sets exactly one per-run DOM attribute (`loam<random>`): no data access, no network request, no persisted effect — the same harmless design as the existing DOM fragment canary.

Verdict rules:

- `observed` — the baseline was clean, the marker was reflected into the response, and the canary executed (the DOM attribute equals the per-run marker). Emits an `xss_reflected_<case-hash>` finding (high): execution is attributed to the declared parameter because the marker did not exist on the baseline page and is random per run.
- `not_observed` — the parameter was reflected without executing within the observation window (encoding, sanitization or policy blocking; blocked/failed/runtime counters are recorded), or the parameter value was not reflected at all (a coverage fact, not a vulnerability).
- `inconclusive` — the baseline control failed (non-success status, route change or a pre-existing marker), or the probe did not complete. Inconclusive cases keep the run `partial` and prove nothing either way.

Controls and evidence: per-case proofs record the baseline status and cleanliness, reflection and execution booleans, per-phase blocked/failed/runtime counters and the harmless marker token. The canary payload itself is never recorded in proofs, findings or evidence, and query strings are stripped from request-evidence URLs, so the payload never reaches stored output. Screenshots reuse the standard input masking. Retests preserve the case list with the other browser options, so an encoded repair can move the finding to `notObserved`. The diagnostics module `xss_reflected` reports planned/conclusive/inconclusive counts.

Honest limits:

- The probe covers one declared parameter in an HTML reflection context with a single canary form; other contexts (attribute, JavaScript string, JSON bodies, POST reflections, stored or second-order reflections, DOM-based flows through scripts reading `location`) are not covered by this engine.
- A non-executing reflection does not prove safety: encoding may hold for this input only, and policy blocking is timing- and configuration-dependent.
- Execution proves the parameter reached an HTML execution context for this input; actual impact depends on the application's data and users.

Validation: `npm run check:security-xss-reflected` runs a real local HTTP fixture in a real Chromium context with (a) a raw reflection executing the canary (observed, clean baseline recorded), (b) an HTML-escaped reflection neutralized (not_observed with reflection recorded), (c) a parameter that is not reflected at all (not_observed, coverage only), (d) a failing baseline page (inconclusive), plus validation rejections (browser disabled, query-bearing path, unsafe parameter name), the never-recorded payload invariant, diagnostics accounting, and a repaired retest closing the finding through `notObserved`. All 21 `check:security*` gates, typecheck for the touched modules and `check:encoding` pass. Worktree-only; not yet in an installed release.
