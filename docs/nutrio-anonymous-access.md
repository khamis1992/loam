# Nutrio access without user accounts — 2026-10-18

The owner explicitly requested testing access without accounts. A targeted read-only API probe ran at 14:19 Riyadh against the backend configured by the locally served Nutrio client: `https://loepcagitrijlfksawfm.supabase.co`. No user password, user access token, personal browser storage or service-role key was used. The public client key was read from the JavaScript module already served by Vite; it was checked to be a publishable key or an `anon` JWT for this project, and not retained in the report.

Supabase distinguishes the public application key from a user session. A public key can reach whatever the anonymous database role is permitted to read; it does not establish a signed-in user. See [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys) and [row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security).

## API evidence

Twelve GET requests compared no-key access with public-client-key access. Table requests selected only `id` with `limit=1`; returned values were not retained. Evidence stores status, byte count, timing, response hash and row count. No mutation or password guessing was performed.

| Endpoint | No key | Public key, no user session | Interpretation |
| --- | --- | --- | --- |
| `/auth/v1/user` | 401 | 401 | No user identity obtained |
| `/rest/v1/public_restaurant_catalog` | 401 | 200, one row | Expected public catalog positive control |
| `/rest/v1/public_meal_catalog` | 401 | 200, one row | Expected public catalog positive control |
| `/rest/v1/profiles` | 401 | 200, empty array | No private row observed; not proof about a known existing record |
| `/rest/v1/restaurants` | 401 | 200, empty array | No base-table row observed |
| `/rest/v1/meals` | 401 | 200, empty array | No base-table row observed |

The repository's `supabase/tests/public-catalog-access.sql` expects anonymous SELECT privileges on the two public views and no SELECT privilege on the two base tables. The live base-table responses were empty 200 responses rather than explicit denials. This is a policy/deployment consistency question, not a confirmed data leak; current grants, RLS and migration state require separate verification. No database configuration was changed.

Evidence: `output/verification/nutrio-anonymous-api.json`. Reproducer: `src/scripts/check-nutrio-anonymous-api.ts` (fixed project and endpoint list). This is a supplementary transport probe, not an execution of the platform's multi-account authorization matrix. Empty result sets alone cannot prove isolation or a repaired vulnerability. Browser evidence is recorded below after the campaign completes.

## Platform browser evidence

Campaign `b387856a-f09d-4bd1-91e1-e4b821120dea` was launched through Loam's installed UI at 14:19:58 Riyadh with no auth headers, no login steps and no imported browser session. Explicit targets were `/nutrio/profile`, `/nutrio/wallet`, `/nutrio/orders`, `/nutrio/dashboard`, and the local root for Vite assets. Limits: 5 browser pages, 6,000 requests, depth 0, 300 seconds, 10 MB/resource and 200 MB/campaign. Readiness required visible welcome/sign-in UI so the test could observe where anonymous navigation landed; it did not establish protected-page readiness.

All five navigation attempts ended at `/nutrio/welcome`, with complete documents, settled networks, zero failed resources and zero runtime errors. The four protected pages were not reached. Ten Vite WebSocket requests were blocked. The campaign completed **partial** in 9.69 seconds with 1,338 requests and 116.32 MB; it did not exhaust its request or time budgets. Four missing-security-header observations concern the local development server, not proven production configuration. No login bypass was observed in these direct-navigation and targeted API checks.

Evidence: `output/verification/nutrio-anonymous-browser.json` and `output/verification/nutrio-anonymous-browser.png`. The platform deliberately marks redirected protected-route rendering as unverified. This result does not prove absence of other authentication bypasses, authorization flaws or unsafe write/RPC operations. No Nutrio source or database state was changed.

## Integrated anonymous API campaign

Revision 35 on installed Loam 0.5.23 ran campaign `a5986512-0ac9-4528-bad0-7b3892b4cc2b` in task `task_mvdrbdmj6b9b6ad845ef` at 14:43 Riyadh. It completed in 5.50 seconds with 267 total requests, including 11 API GETs and 11 explicit CORS OPTIONS preflights. Public catalog controls returned one row each. The profiles, restaurants and meals cases returned empty arrays, with successful public controls before and after each request. No user session or cookies were sent. All three private cases remain inconclusive.

This targeted run rendered one welcome page, received 16.68 MB and blocked two development WebSocket requests. Its one-page discovery limit and unresolved private cases correctly leave overall status partial. Short duration here reflects the bounded five-case plan, not proof of exhaustive testing. API evidence: `output/verification/nutrio-anonymous-platform.json`; installed UI evidence: `output/verification/nutrio-anonymous-platform.png`. The platform API launched this campaign; the actual UI was checked for its five case results and request diagnostics. A separate local fixture verified form launch and retesting after both genuine fixes and misleading empty/error responses. No Nutrio vulnerability was claimed fixed or automatically closed.
