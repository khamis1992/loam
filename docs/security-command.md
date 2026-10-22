# Command injection verification — revision 58

Campaign assessments accept `command`, an explicit list of up to five command-injection cases. Each case declares:

- `path` — the exact POST endpoint (must be allowlisted in `postPaths`) and `field` — the JSON field carrying the value that reaches a shell;
- `benignRef` — a benign separator-free value, fresh per run through `businessSecrets`, never recorded, digest-pinned in the campaign witnesses;
- `templateRef` — the probe template: a value containing the literal placeholder `@LOAM_CMD@` positioned after the operator's chosen shell separator context (for example `127.0.0.1 && @LOAM_CMD@`), validated at normalization.

Execution model (`src/security/command.ts`, run after the deserialization engine): the engine runs a **loopback witness listener** and substitutes the placeholder with an inert canary — exactly one `curl -s http://127.0.0.1:<port>/<token>` (curl ships with Windows 10+ and every common Unix; the URL carries no spaces so it needs no quoting in either shell family). Per case:

1. **Negative baseline** — the separator-free benign value must be accepted (2xx) and cause no listener callback since the case began.
2. **Probe** — the templated value is submitted. The engine polls up to three seconds for the tokenized callback (shell commands run asynchronously).

Verdict rules:

- `observed` — the baseline was clean and the listener received the fresh token. Emits a `command_<case-hash>` finding (**critical**): a command built from user input executed on the application host — remote-code-execution class; any chained command would run the same way. The canary performs one fetch to the engine's own listener and nothing else; no data is accessed.
- `not_observed` — the probe was accepted but the chained command never executed (input validated, escaped, or the value never reaches a shell), or the probe was rejected.
- `inconclusive` — the baseline was not accepted, callbacks arrived before the probe, or the case did not complete. Inconclusive cases mark the run `partial` via a `command_coverage` error finding and prove nothing either way.

Evidence: POST bodies are stored as sizes and hashes only, so neither the benign value nor the probe template appears in stored output; the proof records statuses, the witness port and the callback boolean. Retests preserve the case list and demand fresh values digestting to the baseline, so a host-validation repair can move the finding to `notObserved`. The diagnostics module `command` reports planned/conclusive/inconclusive counts.

Honest limits:

- One declared field and one operator-chosen separator context per case; command injection through headers, cookies, query parameters, filenames or environment variables needs separate declarations.
- The canary assumes a `curl` binary reachable on the target host; minimal containers without curl will read as not_observed without proving safety.
- A clean case proves this payload did not execute for this input — not general command-injection safety; argument-injection (no shell metacharacters) and time-based canaries are not covered.

Validation: `npm run check:security-command` runs a real local HTTP fixture executing real shell commands via `child_process.exec`: (a) a raw-interpolating handler whose chained curl canary reaches the tokenized witness (observed with a clean negative baseline — verified on the Windows host shell), (b) a host-validating handler rejecting the chain at 400 (not_observed), (c) a failing endpoint left inconclusive, plus validation rejections (quick profile, path outside the POST allowlist, query-bearing path, unsafe field name, template missing the placeholder, missing fresh values), two-request evidence accounting with POST policy, template redaction, diagnostics accounting, and a repaired retest (host validation) closing the finding through `notObserved`. All 31 `check:security*` gates, typecheck for the touched modules and `check:encoding` pass. Worktree-only; not yet in an installed release.
