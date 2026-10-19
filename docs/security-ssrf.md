# Server-side request forgery verification — revision 53

Campaign assessments accept `ssrf`, an explicit list of up to five SSRF cases. Each case declares:

- `kind` — `get` (the URL travels in the declared query parameter) or `post` (the URL travels in one declared top-level JSON field; the path must be allowlisted in `postPaths`);
- `path` and `field` — one exact in-scope path and a safe field or parameter name;
- `benignRef` — a benign non-URL baseline value, supplied fresh per run through `businessSecrets`, never recorded, digest-pinned in the campaign witnesses.

Execution model (`src/security/ssrf.ts`, run after the traversal engine): the engine starts an HTTP **callback listener bound to 127.0.0.1** for the duration of the run and, per case, sends two requests:

1. **Negative baseline** — the benign value must complete at the transport level (a client error is acceptable; a server error makes the case inconclusive) and must produce **zero** listener callbacks. This proves the listener is silent absent a URL payload.
2. **Tokenized probe** — a URL of the form `http://127.0.0.1:<listener-port>/<random-token>`. If the application fetches it, the listener receives the callback carrying the fresh token. The engine polls for up to three seconds so fire-and-forget (asynchronous) fetches are also captured.

Verdict rules:

- `observed` — the baseline was clean and the listener received the token. Emits an `ssrf_<case-hash>` finding (high): only the application under test can reach the loopback listener, and the token is unique to this probe, so the callback proves a server-side request to an attacker-influenced URL. The probe URL and token never appear in stored output.
- `not_observed` — the baseline was clean but the probe completed or was rejected without any callback (blocked, allowlisted, validated or not fetched).
- `inconclusive` — the baseline did not complete or failed with a server error, callbacks arrived before any URL probe (unattributable listener), or the case did not complete. Inconclusive cases mark the run `partial` via an `ssrf_coverage` error finding and prove nothing either way.

Evidence: query strings are stripped from recorded evidence URLs and POST bodies are stored as sizes and hashes only, so neither the baseline value nor the probe URL is persisted. The proof records baseline/probe statuses, the callback port and the callback boolean. Retests preserve the case list and demand a fresh baseline digestting to the baseline, so a host-allowlist repair can move the finding to `notObserved`. The diagnostics module `ssrf` reports planned/conclusive/inconclusive counts.

Honest limits:

- The listener binds loopback, so the proof applies to targets reachable from the engine host (local or same-machine deployments); testing remotely hosted applications requires a reachable callback host, which is future work.
- One declared field per case with one loopback HTTP target; DNS rebinding, redirect chains, cloud metadata endpoints, gopher/file schemes and IP-notation tricks are not covered — a clean case proves this destination was not fetched for this input, not general SSRF safety.
- No third-party host is ever contacted by the engine; only the application under test can cause outbound traffic, and only to the engine's own listener.

Validation: `npm run check:security-http`-style integration aside, `npm run check:security-ssrf` runs a real local HTTP fixture against the real engine listener: (a) an awaited server-side fetch hitting the tokenized callback (observed with a clean negative baseline), (b) a fire-and-forget fetch also observed within the polling window, (c) a host-allowlist guard rejecting the probe with no callback (not_observed at 400), (d) a failing endpoint left inconclusive by the server-error baseline rule, plus validation rejections (quick profile, POST path outside the allowlist, query-bearing path, unsafe field name, missing fresh baseline), two-request evidence accounting, baseline redaction, diagnostics accounting, and a repaired retest (host allowlist) closing both findings through `notObserved`. All 26 `check:security*` gates, typecheck for the touched modules and `check:encoding` pass. Worktree-only; not yet in an installed release.
