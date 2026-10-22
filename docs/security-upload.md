# File upload verification — revision 54

Campaign assessments accept `upload`, an explicit list of up to five upload cases. Each case declares:

- `path` — the exact multipart POST endpoint (must be allowlisted in `postPaths`) and `field` — the multipart field carrying the file;
- `viewPath` + `viewParam` — the exact GET path (default parameter `name`) from which uploaded content is served;
- five fresh per-run values through `businessSecrets`: the benign file name and content (`benignNameRef`/`benignContentRef` — a declared-valid file), the probe name and content (`probeNameRef`/`probeContentRef` — a type the operator declares disallowed, e.g. `loam-probe.html`), and `markerRef` — a distinctive substring of the probe content that must be contained in it (validated) and acts as the retrieval witness.

Execution model (`src/security/upload.ts`, run after the SSRF engine): per case, three requests:

1. **Positive control** — the benign declared-valid file must be accepted (2xx). This proves the endpoint accepts uploads and that the operator's model of it is correct.
2. **Probe upload** — the disallowed-type file is uploaded. The probe is inert marker text; nothing executable is ever generated.
3. **Retrieval witness** — the declared view must serve the probe content verbatim (the marker appears in the response body) for the finding to fire.

Verdict rules:

- `observed` — the benign file was accepted, the disallowed-type probe was also accepted, and the declared view served its content verbatim. Emits an `upload_<case-hash>` finding (high): unrestricted upload of a disallowed type that is stored and served back. The marker, filenames and contents never appear in stored output.
- `not_observed` — the probe was rejected (for example by a 415 extension allowlist) while the benign file was accepted, or the probe was accepted but its content was not served from the declared view (normalized, quarantined or unreachable).
- `inconclusive` — the benign control was not accepted, or the case did not complete. Inconclusive cases mark the run `partial` via an `upload_coverage` error finding and prove nothing either way.

Evidence: multipart POSTs carry `postPolicy` with the request byte size; the view GET's query string is stripped from recorded evidence URLs; response bodies are stored as hashes only. Retests preserve the case list and demand fresh values digestting to the baseline, so an extension-allowlist repair can move the finding to `notObserved`. The diagnostics module `upload` reports planned/conclusive/inconclusive counts.

Honest limits:

- One declared disallowed name/content per case; content-signature (magic-byte) validation, double extensions, null bytes, MIME confusion, zip bombs and size limits are not automatically probed — each is a separate operator declaration.
- The witness proves the file was stored and served verbatim for this input; whether serving it is exploitable depends on the serving content type and downstream processing, which this engine does not execute.
- Multipart file fields only in this revision; base64 JSON uploads and multi-file forms are not covered.

Validation: `npm run check:security-upload` runs a real local HTTP fixture with a real multipart parser: (a) an open endpoint accepting the benign file and the disallowed-type probe and serving the probe verbatim (observed with the benign control recorded), (b) an extension-allowlist endpoint rejecting the probe at 415 while accepting the benign file (not_observed), (c) a failing endpoint left inconclusive by the broken positive control, plus validation rejections (quick profile, path outside the POST allowlist, query-bearing view path, unsafe field name, probe content missing the declared marker, missing fresh values), two-upload-plus-one-view evidence accounting with POST policy, filename/content/marker redaction from all stored output, diagnostics accounting, and a repaired retest (extension allowlist) closing the finding through `notObserved`. All 27 `check:security*` gates, typecheck for the touched modules and `check:encoding` pass. Worktree-only; not yet in an installed release.
