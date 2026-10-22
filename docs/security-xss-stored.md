# Stored cross-site scripting verification — revision 50

Browser-enabled campaigns accept `browser.xssStored`, an explicit list of up to five stored-XSS cases. Each case declares:

- `postPath` — the exact POST path that stores the value (must be allowlisted in `postPaths`);
- `bodyRef` — a fresh per-run JSON body (validated in `browserSecrets`, digest pinned in the campaign witnesses);
- `field` — the top-level JSON field whose value is replaced by the harmless canary before submission;
- `viewPath` — the exact GET path where the stored value is later rendered.

Execution model (`src/security/xss-stored.ts` + the browser engine in `src/security/browser.ts`), per case:

1. **Baseline control** — an isolated viewer context loads the declared view; it must render a successful document at the requested route and carry no trace of the fresh per-run marker.
2. **Authorized storage** — a separate author context submits the body (with the canary in the declared field) to the POST path; the submission must be accepted. The canary is the same harmless design as the reflected probe (`"><img src=x onerror=...>` setting exactly one per-run DOM attribute; no data access, no network request).
3. **Fresh viewer** — a brand-new isolated viewer profile loads the view again; the engine observes reflection (the marker in the rendered HTML) and execution (the DOM attribute equal to the marker).

Verdict rules:

- `observed` — the baseline was clean, the storage was accepted, and the canary executed in the fresh viewer profile. Emits an `xss_stored_<case-hash>` finding (high): execution is attributed to the stored payload because the marker did not exist on the baseline view and is random per run.
- `not_observed` — the stored value was rendered without executing within the observation window (encoding, sanitization or policy blocking), or was not rendered in the declared view at all (a coverage fact, not a vulnerability).
- `inconclusive` — the baseline view failed to render cleanly, the storage submission was rejected, or the probe did not complete. Inconclusive cases keep the run `partial` and prove nothing either way.

Evidence and controls: per-case proofs record the baseline status and cleanliness, the storage status, the fresh view status, reflection and execution booleans. The canary payload and the stored body value never appear in proofs, findings or evidence. Retests preserve the case list with the other browser options and demand a fresh body digestting to the baseline, so an encoding repair can move the finding to `notObserved`. The diagnostics module `xss_stored` reports planned/conclusive/inconclusive counts.

Honest limits:

- The viewer is a fresh isolated browser profile sharing the campaign session; genuinely cross-account viewing (a second declared test account as the victim) is future work, as are views requiring interactive navigation to reach, moderation queues, and delayed rendering.
- The probe covers one declared field in an HTML render context; attribute contexts, JSON-rendered SPA views, Markdown/rich-text pipelines and file-based payloads are not covered.
- A non-executing render does not prove safety for other inputs or contexts, and execution proves the stored field reached an HTML execution context for this input only.
- Stored canaries persist in application data after the run (test-data cleanup remains an open platform gap).

Validation: `npm run check:security-xss-stored` runs a real local HTTP fixture in real Chromium contexts: (a) a raw-rendering board executing the stored canary in a fresh viewer (observed, clean baseline recorded), (b) an HTML-escaping board neutralizing it (not_observed with reflection recorded), (c) stored content never rendered by the declared view (not_observed, coverage only), (d) a rejected storage submission (inconclusive), plus validation rejections (browser disabled, path outside the POST allowlist, query-bearing view path, missing fresh body), the never-recorded payload and body invariants, diagnostics accounting, and a repaired retest (escaping) closing the finding through `notObserved`. All 23 `check:security*` gates, typecheck for the touched modules and `check:encoding` pass. Worktree-only; not yet in an installed release.
