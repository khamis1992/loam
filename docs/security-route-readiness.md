# Route-specific readiness — revision 14

The browser supports `readyRoutes`, an optional array of up to 100 exact frontend paths and nonempty selectors. The UI exposes the array next to the global readiness selector and requires engine revision 14 when rules are supplied.

```json
[
  {"path":"/login","selector":"#signin-email"},
  {"path":"/dashboard","selector":"[data-dashboard-ready]"}
]
```

These are illustrative selectors; configure witnesses from the actual application. A route rule overrides the global selector for that requested path. Other paths retain the global fallback. The original rule remains selected if the application redirects elsewhere, so a login page cannot replace a dashboard readiness requirement. Final-route verification independently prevents claiming coverage of a different route.

Rules require one frontend origin, stay within approved scope, reject duplicate paths, queries, fragments, noncanonical paths and empty selectors. They do not broaden scope, grant API permissions or establish account identity. Rules apply where browser loading requests readiness; explicit login/SPA steps continue to use their own assertions. Evidence records the selected selector on success and on failed loading. Retests preserve the original rules.

Validation:

- `npx tsx src/scripts/check-security-route-readiness.ts`: two pages with distinct readiness elements; delayed dashboard readiness; invalid/duplicate rules; redirect retains the dashboard requirement; successful login-page control; retest persistence.
- `npm run check:security-resource-budgets`: resource limits, delayed readiness and retests remain valid.
- `npm run check:security-http`: UI field reaches the server's persisted campaign; account matrix, evidence and retest workflow regression.
- Typecheck and server build passed.

Installed revision 14 on Loam 0.5.14, preserving the profile and 45 tasks. Backup: `output/verification/security-runtime-backup-20261018-110519`.

Nutrio authenticated readiness still requires known test-user content and identity witnesses. No protected-content success is inferred from these generic fixtures.
