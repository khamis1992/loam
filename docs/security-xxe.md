# XML external entity verification — revision 56

Campaign assessments accept `xxe`, an explicit list of up to five XXE cases. Each case declares:

- `path` — the exact POST endpoint (must be allowlisted in `postPaths`) and `field` — the JSON field carrying the XML document;
- `benignXmlRef` — a benign entity-free XML document, fresh per run through `businessSecrets`, never recorded, digest-pinned in the campaign witnesses;
- `templateRef` — the probe template: an XML document containing the literal placeholder `@LOAM_ENTITY_REF@` where the entity reference must sit (validated at normalization).

Execution model (`src/security/xxe.ts`, run after the template engine): the engine runs a **local loopback entity server** serving an inert per-run marker. Per case:

1. **Negative baseline** — the entity-free benign XML must be accepted and its response must contain no marker and cause no entity-server hit (counted since the case began).
2. **XXE probe** — the engine injects a `<!DOCTYPE loam [<!ENTITY loam SYSTEM "http://127.0.0.1:<port>/<token>">]>` declaration into the template (after the XML declaration when present) and substitutes the placeholder with `&loam;`. Two independent witnesses decide the verdict:
   - **Reflection** — the response contains the marker (the entity was resolved into application output);
   - **Callback** — the entity server received a request for the fresh token (the parser fetched the external entity without reflection — blind XXE). The engine polls briefly for asynchronous parsers.

Verdict rules:

- `observed` — the baseline was clean and either witness fired. Emits an `xxe_<case-hash>` finding (high) whose detail names which witness fired. Only the engine's own inert marker is ever served; no `file://` or remote entities are used.
- `not_observed` — neither witness fired: the entity was not resolved and the parser did not fetch it (DTD processing disabled, DOCTYPE stripped or rejected).
- `inconclusive` — the baseline failed, already carried the marker, or an earlier hit made the listener unattributable; or the case did not complete. Inconclusive cases mark the run `partial` via an `xxe_coverage` error finding and prove nothing either way.

Evidence: POST bodies are stored as sizes and hashes only, so neither the benign XML nor the probe document appears in stored output; the proof records statuses, the entity port and the two witness booleans. Retests preserve the case list and demand fresh values digestting to the baseline, so a parser-configuration repair (disable DTD/external entities) can move the finding to `notObserved`. The diagnostics module `xxe` reports planned/conclusive/inconclusive counts.

Honest limits:

- The entity URL is loopback HTTP only; local-file disclosure via `file://`, parameter entities for data exfiltration, XInclude and billion-laughs denial are not probed.
- The XML travels inside a declared JSON field; raw `application/xml` request bodies, SOAP endpoints and multipart XML uploads are not covered in this revision.
- A clean case proves this parser did not resolve this declared external entity for this input — not general XML hardening.

Validation: `npm run check:security-xxe` runs a real local HTTP fixture against the real engine entity server: (a) an entity-resolving handler producing both witnesses (observed: the marker reflected and the tokenized callback received), (b) a DOCTYPE-stripping handler firing neither (not_observed), (c) a failing endpoint left inconclusive by the failed baseline, plus validation rejections (quick profile, path outside the POST allowlist, query-bearing path, unsafe field name, template missing the placeholder, missing fresh values), two-request evidence accounting with POST policy, redaction of the benign XML and template, diagnostics accounting, and a repaired retest (parser configuration) closing the finding through `notObserved`. All 29 `check:security*` gates, typecheck for the touched modules and `check:encoding` pass. Worktree-only; not yet in an installed release.
