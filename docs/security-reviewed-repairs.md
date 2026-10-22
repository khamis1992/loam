# Reviewed source repairs — revision 10

The first supported repair is a direct JavaScript/TypeScript `innerHTML = ...` assignment converted to `textContent = ...`. This is appropriate only when plain text is intended. It changes HTML-rendering behavior and is not a universal XSS repair or an automatic sanitizer insertion.

Revision 40 adds eligible direct `insertAdjacentHTML(position, value)` calls converted to `insertAdjacentText(position, value)`, retaining a recognized literal position and both arguments. See `security-html-insertion-repair.md` for the AST eligibility rules and real-browser repair/rollback verification.

Source assessments now retain file hashes. A proposal requires a matching current file hash, valid UTF-8, parseable source and exactly one supported AST assignment at the reported line. Comments, string contents, ambiguous same-line assignments and changed files are rejected. Older assessments without hashes require a new source scan.

The finding UI offers preparation, review, application and rollback. Preparation leaves the source untouched and displays the file, line, property change and before/after hashes. Applying or rolling back requires the review checkbox. Edits are limited to the task workspace; paths containing symlinks/junctions are rejected. The original source is retained locally under `.loam/security/repairs` for rollback; backups can contain application secrets and are not included in the repair API response.

Application changes only the selected property token. Before replacing the file, the current hash is checked again. Rollback requires the applied-file hash to match and the saved original to match its hash, so subsequent edits are not silently overwritten. Repair metadata persists across page reloads. This is not a Git worktree, a merge engine or protection against arbitrary local filesystem tampering or storage-device failure; keep normal repository history/backups.

Revision 11 adds a pending-operation journal written before source replacement. Backup, replacement and journal writes are flushed before rename. If the process stops between the source update and final metadata update, reading the repair reconciles its state with the current source and original backup hashes. Recovery never rewrites the source. Unexpected content or a corrupt backup is surfaced as `conflict`, with apply/rollback controls withheld. Apply and rollback are refused while an assessment is active in the same task, preventing intentional changes during evidence collection.

Regression fixtures emulate interruption before and after both apply and rollback, verify a reviewed retry after an unapplied operation, preserve concurrent user edits, reject corrupt backups, and exercise recovery through a UI reload. These are process-interruption tests, not a hardware power-loss guarantee.

Neither applying a proposal nor disappearance of a static pattern closes a finding. Run application-specific functional tests, then the original security reproducer through assessment retesting. Unsupported languages, ambiguous code and fixes requiring application policy are left for manual engineering review.

Validation:

- `npm run check:security-repairs`: vulnerable DOM fragment fixture → reviewed source edit → browser canary no longer executes → rollback → original canary executes again. Also checks stale edits, required review, retained state, comment/string false matches and ambiguous assignments.
- `npm run check:security-http`: local-source mode exercises preparation, review, apply, reload and rollback through the real UI, plus task isolation. Installed-runtime testing enables the same source fixture with `LOAM_SECURITY_TEST_REPAIRS=1`; it writes only `repair.js` in a newly created test task after validating the returned workspace path.

This establishes one reviewed remediation workflow. It does not prove that the platform can repair arbitrary vulnerabilities or preserve all application behavior automatically.

Installed verification: revision 10 in Loam 0.5.13 passed `LOAM_SECURITY_TEST_BASE=http://127.0.0.1:3939 LOAM_SECURITY_TEST_REPAIRS=1 npm run check:security-http` on 2026-10-18. The synthetic file was restored by the rollback test. No Nutrio source was changed. TypeScript, server build and the standalone repair regression passed.
