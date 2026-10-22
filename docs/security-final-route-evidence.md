# Final-route evidence (security revision 13)

The browser previously attached DOM inspection and coverage to the requested URL even when an application navigated to another route. A shared readiness selector on a login page could therefore overstate coverage of a protected page.

Render evidence now includes `finalUrl` and `routeChanged`. Query strings, fragments and embedded URL credentials are stripped, and known secrets are redacted. The UI shows the final URL beside the requested URL; diagnostics summarize changed routes. Both successful loading and readiness failures report the observed URL.

When the origin/path changes, the requested route is inconclusive, its rendered DOM findings and coverage are not recorded, and its subsequent optional DOM/frame probes are skipped. Links can still be discovered subject to the existing scope. Canonical redirects also count as changed routes; select the canonical URL explicitly to establish its coverage.

This does not identify all login pages: same-path login screens and hash-only SPA navigation require explicit identity/content witnesses. The final URL is evidence, not proof of account identity or authorization.

Validation: `npx tsx src/scripts/check-security-route-evidence.ts` exercises SPA history replacement and HTTP redirect to a login page sharing the readiness selector, URL-secret stripping, absence of original-route DOM coverage, and restoration of same-route coverage on retest. The existing browser suite covers DOM/frame/auth tests, fixed/unavailable retests, egress, quotas and cancellation. UI integration checks visibility of the final-page label.

Installed revision 13 on Loam 0.5.14; 43 tasks and the profile were preserved. Backup: `output/verification/security-runtime-backup-20261018-110146`.

Nutrio verification run `87df3707-08cb-48d7-addc-e33332e9083d` requested `/nutrio/dashboard` and observed `/nutrio/welcome`. The document and readiness selector loaded without failed resources/runtime errors, but `routeChanged: true` correctly prevents claiming dashboard DOM coverage. This clarifies the older anonymous rendering results. Evidence: `output/verification/nutrio-revision13.json`.
