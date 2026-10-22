# Unsafe deserialization verification — revision 57

Campaign assessments accept `deser`, an explicit list of up to five deserialization cases. Each case declares:

- `path` — the exact POST endpoint (must be allowlisted in `postPaths`) and `field` — the JSON field carrying the serialized payload;
- `benignRef` — a benign function-free serialized value, fresh per run through `businessSecrets`, never recorded, digest-pinned in the campaign witnesses;
- `templateRef` — the probe template: a serialized string containing the literal placeholder `@LOAM_FUNC@` where the function payload must sit (validated at normalization).

Execution model (`src/security/deserialization.ts`, run after the XXE engine), targeting the canonical Node vector — serializers that evaluate values tagged with the node-serialize `_$$ND_FUNC$$_` prefix:

1. The engine runs a **loopback witness listener** for the duration of the run.
2. **Negative baseline** — the function-free benign value must be accepted (2xx) and cause no listener callback since the case began.
3. **Probe** — the template's placeholder is substituted with an inert canary: `_$$ND_FUNC$$_function(){fetch('http://127.0.0.1:<port>/<token>').catch(function(){});}` — single quotes only, since the body travels inside a serialized string value. The engine polls up to three seconds for the tokenized callback.

Verdict rules:

- `observed` — the baseline was clean and the listener received the fresh token. Emits a `deser_<case-hash>` finding (**critical**): the application's deserializer evaluated a function carried in serialized data — remote-code-execution class; any function body would run the same way. The canary performs exactly one fetch to the engine's own listener; no data is accessed.
- `not_observed` — the probe was accepted but the canary never executed (data-only parsing, or the function tag is stripped/rejected).
- `inconclusive` — the baseline was not accepted, callbacks arrived before the probe (unattributable), or the case did not complete. Inconclusive cases mark the run `partial` via a `deser_coverage` error finding and prove nothing either way.

Evidence: POST bodies are stored as sizes and hashes only, so neither the benign value nor the canary appears in stored output; the proof records statuses, the witness port and the callback boolean. Retests preserve the case list and demand fresh values digestting to the baseline, so a tag-rejecting repair can move the finding to `notObserved`. The diagnostics module `deser` reports planned/conclusive/inconclusive counts.

Honest limits:

- One vector per case: the node-serialize function tag inside one declared JSON field. Java/PHP/.NET gadget chains ( CommonsCollections, `__wakeup__`, ViewState, BinaryFormatter), YAML object tags and prototype pollution via `__proto__` are not covered — each needs its own operator-declared canary family.
- A clean case proves this declared payload was not evaluated by this endpoint — not general deserialization safety; serializers using different evaluation tags will read as not_observed unless a matching template is declared.
- The witness proves execution of the submitted function only; impact beyond RCE-class potential depends on the runtime's privileges.

Validation: `npm run check:security-deserialization` runs a real local HTTP fixture implementing the node-serialize evaluation contract: (a) an evaluating unserializer executing the canary and hitting the tokenized witness (observed with a clean negative baseline), (b) a tag-stripping unserializer firing no callback (not_observed), (c) a failing endpoint left inconclusive by the unaccepted baseline, plus validation rejections (quick profile, path outside the POST allowlist, query-bearing path, unsafe field name, template missing the placeholder, missing fresh values), two-request evidence accounting with POST policy, redaction of the benign value and template, diagnostics accounting, and a repaired retest (tag rejection) closing the finding through `notObserved`. All 30 `check:security*` gates, typecheck for the touched modules and `check:encoding` pass. Worktree-only; not yet in an installed release.
