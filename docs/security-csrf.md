# Cross-site request forgery verification — revision 49

Browser-enabled campaigns accept `browser.csrf`, an explicit list of up to five CSRF cases. Each case declares one state-changing POST that is already allowlisted in `postPaths`, plus a numeric state witness:

- `path` — the exact POST path (must be in the `postPaths` allowlist);
- `bodyRef` — fresh per-run JSON body (validated in `browserSecrets`, digest pinned in the campaign witnesses);
- `statePath` + `statePointer` + `stateDelta` — a JSON Pointer witness whose declared movement proves application of the operation.

The browser option `csrfCookieSameSite` (Lax/Strict/None, default Lax) controls the SameSite attribute of the injected campaign session cookie so the victim cookie mirrors the real application cookie's policy; `None` additionally sets `Secure` as browsers require.

Execution model (`src/security/csrf.ts` + the browser engine in `src/security/browser.ts`): a session context carrying the victim cookie (campaign cookie authentication or a browser login is required — otherwise the case is inconclusive) first executes the operation **same-origin** as the positive control: the POST must be accepted and the witness must advance by the declared delta. A synthetic foreign-origin page served by the local harness (it loads no application script or data) then issues exactly one simple cross-origin request to the same path — plain text body, no custom headers, `credentials: include` — exactly as a foreign page can. Whether that request carries the victim session is decided by the browser's own cookie policy (SameSite) and the server's defenses; the engine only measures the outcome.

Verdict rules:

- `observed` — the control applied the declared delta and the cross-origin submission applied it again under the victim session. Emits a `csrf_<case-hash>` finding (high) with the probe status and the observed session-cookie SameSite attribute. This is exploit-level proof: the operation executed from a foreign origin.
- `not_observed` — the cross-origin submission was rejected (for example by a missing session, SameSite enforcement, a token or Origin/Fetch-Metadata validation) or did not apply the effect, while the same-origin control succeeded.
- `inconclusive` — no victim session is available, the same-origin control was rejected or did not apply the declared delta, the state witness is unavailable, or the probe did not complete. Inconclusive cases keep the run `partial` and prove nothing either way.

Evidence and controls: per-case proofs record control and probe statuses, whether the browser issued the probe, the witness values before/after each phase, and the session cookie's SameSite/Secure attributes. Both POSTs carry `postPolicy` evidence; the probe body and session values are redacted from all stored output. Retests preserve the case list with the other browser options and demand a fresh body digestting to the baseline, so an Origin-validation repair can move the finding to `notObserved`. The diagnostics module `csrf` reports planned/conclusive/inconclusive counts.

Honest limits:

- The probe models a simple cross-origin request (plain text body, no custom headers). Defenses that only block preflighted requests, form-encoded submissions, or top-level form navigations are not exercised; a JSON endpoint that strictly requires `application/json` will reject the probe without proving safety.
- The injected cookie's SameSite policy is operator-declared and must match the real application cookie; a mismatch can over- or under-state protection. Cookies without a SameSite attribute are treated as Lax by current Chromium, so legacy cookies will typically show as protected in this engine even though other clients may differ.
- A clean case proves this defense held for this request shape only. Redirect-based CSRF (unsafe redirects on GET), login CSRF and SameSite bypass chains are not covered.

Validation: `npm run check:security-csrf` runs a real local HTTP fixture in a real Chromium context with a victim session: (a) an unguarded transfer applied by the cross-origin probe through a SameSite=None session cookie (observed, probe status and cookie attributes recorded), (b) a Fetch-Metadata/Origin-guarded endpoint rejecting the probe while its same-origin control applies (not_observed), (c) an always-rejected endpoint left inconclusive by the failed control, plus validation rejections (browser disabled, path outside the POST allowlist, bad SameSite value, missing fresh body), POST policy evidence for both submissions, balance arithmetic for control-versus-probe application, session redaction, diagnostics accounting, and a repaired retest (Origin validation) closing the finding through `notObserved`. All 22 `check:security*` gates, typecheck for the touched modules and `check:encoding` pass. Worktree-only; not yet in an installed release.
