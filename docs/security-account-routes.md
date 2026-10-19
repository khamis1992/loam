# Multi-account route attribution — revision 38

Identity witnesses previously checked visible text, status and transport but did not require the final URL to remain the configured identity route. UI authorization cases similarly checked selector/status evidence without binding it to the requested resource route. A copied identity or protected selector on a different SPA page could therefore support a misleading account-control or authorization result.

The identity witness now requires the exact normalized requested URL, including query and fragment, during session establishment and the checks before and after each authorization observation. UI case validity likewise requires that the resource page remain at the requested URL. Changed routes leave the case inconclusive; baseline findings remain unverified on retest. API case requests already reject redirects; their shared browser identity witnesses also receive this stricter route check.

Session and authorization proofs record target-reached flags and sanitized final origin/path URLs. New fields omit query and fragment values. A valid direct denial still produces not-observed coverage when identities, allowed-account controls and transport checks succeed. Legitimate alternate routes are conservatively unverified; this is not a general identity-provider equivalence model.

Regression: `src/scripts/check-security-account-routes.ts`. A real Chrome fixture establishes exposure between two distinct bearer-authenticated accounts, then tests moved allowed/denied resource pages, relocated denial UI, query/hash changes, identity relocation at setup and after resource observation, and a direct denial fix. It verifies retest fingerprint classification and absence of supplied tokens and generated final-URL secrets from persisted evidence.

This strengthens attribution rather than adding exhaustive authorization coverage. Known test-account identities and sensitive-resource witnesses still need explicit configuration. No Nutrio account or personal session was used.

Source route regression, existing multi-account/API/POST regression, full-project typecheck and server build passed. Revision 38 was installed on Loam 0.5.23, preserving 123 tasks and the profile, with all four deployed files matching the staged candidate. Backup: `output/verification/security-runtime-backup-20261018-145426`.

Installed-service verification also passed using `LOAM_SECURITY_TEST_BASE=http://127.0.0.1:3939`. The `Multi-account route regression` task retains the baseline and eight retest campaigns. This proves the new route attribution through the deployed assessment/retest endpoints; the UI layout itself was unchanged.
