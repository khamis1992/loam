# Nutrio UI verification — 2026-10-18

## UI rerun at 14:03 Riyadh

Run `2e17d7a7-2844-467a-90ac-038aacde6f07` was launched from the installed UI and finished **partial** in 40.03 seconds: 1,255/3,000 requests and three render attempts. Evidence: `output/verification/nutrio-ui-current.json`; UI screenshot: `output/verification/nutrio-ui-current.png`.

Welcome returned 200 with document complete, network settled, its readiness selector visible, and no failed resources or runtime errors. The sign-in flow completed all four assertions. Dashboard redirected to welcome and timed out waiting for its distinct dashboard selector. The root also redirected to welcome. Ten blocked WebSocket requests were recorded. JavaScript resource counts do not establish API coverage. Login, POST, authenticated API access and authorization repair remain unverified.

The login draft was restored in the live form after the anonymous run, using temporary `ownerEmail` and `ownerPassword` and ending with `[data-testid="dashboard-orbit-dock"]`. A start attempt with missing values was correctly rejected before login. The completed run retains its anonymous configuration. No personal browser session was imported.

For the authenticated continuation, designate the Supabase test project, supply verified test accounts A/B with expected IDs and roles, and specify synthetic owned records and exact allowed/denied API paths. Enter secrets only in the UI temporary-values field. API comparisons additionally need short-lived user tokens and the public project key, never a service-role key.

## UI rerun at 12:19 Riyadh

Run `380f79f9-8983-49d9-a791-969a4d73a237` was launched through the installed UI. It finished partial in 37.25 seconds with 1,259/3,000 requests and 86.93/200 MB. Evidence: `output/verification/nutrio-ui-check-20261018.json`.

The main target is `/nutrio/welcome`; explicit seeds are `/nutrio/dashboard` and the local origin root (needed for Vite resources). Browser page limit is three. Readiness rules distinguish the welcome sign-in button from the dashboard orbit dock; timeout is 30 seconds with 10 seconds for network settling.

Welcome returned 200 with document complete, network settled and its specific readiness selector visible. The four sign-in form checks completed. Dashboard redirected to welcome and failed its dashboard readiness check. The origin root also redirected. Ten blocked requests keep overall browser coverage partial. No authenticated login, separate API access or POST was executed. Counts of JavaScript resource requests do not establish API coverage.

The login recipe is restored as a draft after this anonymous run. Supply `ownerEmail` and `ownerPassword` in temporary values for a designated test user, then configure the designated backend's exact endpoint grants. For account A/B authorization comparisons, also provide each expected user ID, role, completed onboarding status, synthetic owned-record IDs, exact read paths and expected allow/deny outcomes. API probes require short-lived user access tokens and the public project key; no service-role credential is needed. The remote Supabase project must be identified as the intended test backend before those probes are configured and run.

This run demonstrates real browser execution and distinguishes public rendering from protected coverage. It does not establish authenticated API coverage or verify any authorization repair.

## Latest UI rerun (11:37 Riyadh)

Run `8b311518-45f1-4cf5-9ee3-49af8123ff08` was started through the installed UI: 35.12 seconds, 999/3,000 requests, 68.02/200 MB, two render attempts, partial coverage. Raw sanitized report: `output/verification/nutrio-ui-readiness-latest.json`.

Scope includes the local origin root for Vite resources and targets `/nutrio/dashboard`. Readiness is 30 seconds, network settling 10 seconds, maximum resource 10 MB. Dashboard now requires `[data-testid="dashboard-orbit-dock"]`, verified in Nutrio's Dashboard.tsx. The earlier shared navigation selector also appears outside the protected dashboard and must not establish readiness.

The new run timed out at dashboard readiness and recorded final URL `/nutrio/welcome`; it did not exhaust the request budget. The sign-in flow completed all four control assertions. Eight WebSocket requests were blocked; no resource failures or runtime errors were recorded in the dashboard proof. Authenticated login, POST and remote API coverage remain zero/unverified.

The live UI has a prepared, unexecuted login recipe using `ownerEmail` and `ownerPassword`, ending in the dashboard-specific assertion. These credentials are missing. The form is a live draft; the completed run retains its anonymous configuration. No personal browser session was imported and no Nutrio data was modified.

For the next authenticated run, provide two verified test users (email/password, expected user ID, role, completed onboarding/MFA requirements), designate the test Supabase project, and identify synthetic A/B-owned records with exact API paths and expected access. For explicit API account probes, supply each test user's short-lived access token and the project's public publishable/anon key in temporary values; never a service-role key. Login requires an explicit grant for the test backend's login POST endpoint; identity and record reads require their exact GET grants. Do not grant all tables or mutation endpoints merely to make loading succeed.

Executed using the installed platform at http://127.0.0.1:3939/security.html, in task `task_mvdgpt5nebe502e9c213`, with isolated anonymous Chrome sessions.

## Configuration and evidence

- Local origin scope: `http://127.0.0.1:5173/`, including scripts outside `/nutrio/`.
- Browser enabled; same-origin redirects allowed; readiness selector `[data-testid="onboarding-signin-btn"], [data-testid="signin-screen"]`; readiness timeout 30 seconds, network idle timeout 10 seconds; resource limit 10 MB, total 200 MB; request ceiling 1,000, duration ceiling 300 seconds.
- Broad run `4cbf4c46-1682-4397-8c1e-3a8db33a5731`: 35.98 seconds, 1,000 requests, 66.24 MB. Exhausted the request ceiling while loading Vite modules. Five discovered/attempted URLs are NOT five successfully rendered pages. Dashboard and meals rendering could not complete after budget exhaustion.
- Targeted dashboard run `90389c2a-5d3b-4947-9f63-03d032ce7eb9`: 754 requests, 4.05 seconds, 51.04 MB. Rendering evidence records HTTP 200, document complete, network settled, readiness selector visible, zero failed resources and zero runtime errors. Six WebSocket requests were blocked across flow and render, so the result remains partial.
- Sign-in UI flow completed all four steps: navigate to `/auth?skip_welcome=1&tab=signin`, verify email, password and submit controls. This does not constitute successful login. The anonymous readiness selector does not prove protected dashboard content.
- A subsequent UI run `55bf2ca2-336b-496c-af49-c546ba31b0ee` likewise ended partial with 752 requests in 4.31 seconds.
- Local development server has missing security headers; this is not evidence about deployed production configuration.

Full evidence: `output/verification/nutrio-ui-budget.json` and `output/verification/nutrio-ui-targeted.json`.

## Login preparation and missing inputs

The login recipe is prepared in the live UI using temporary `ownerEmail` and `ownerPassword` references, then submitting `[data-testid="signin-submit-btn"]` and asserting `nav[aria-label="Primary navigation"]`. No credentials were supplied or login executed. The final assertion only verifies landing UI; account identity requires its own witness.

The configured Supabase origin is `https://loepcagitrijlfksawfm.supabase.co`. The platform now supports explicit API-origin grants, unlike the earlier report in `nutrio-local-assessment.md`. No grant or authenticated API access was exercised in these runs. Specify the designated test backend before configuring exact login, identity and record paths.

Required inputs:

1. Two existing verified test users A/B: email, password, expected user ID and same ordinary role; optionally a third elevated-role user.
2. Expected visible identity and selector, plus onboarding/MFA requirements.
3. Synthetic records owned by A and B: exact read-only API paths, identifiers and unique expected markers.
4. Expected allowed/denied access for each account, and designated Supabase test project.

Enter passwords in the platform's temporary values field, not this report. Do not use a service-role key. Authenticated API coverage and authorization retests remain unverified until these inputs are available. For the large development build, use targeted campaigns or a production build preview rather than interpreting a request-budget cutoff as completed coverage.
