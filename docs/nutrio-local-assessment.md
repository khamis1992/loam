# Nutrio local assessment — 2026-10-18

Executed through the installed Loam UI at http://127.0.0.1:3939/security.html.
Task: `task_mvdgpt5nebe502e9c213`.
Scope: `http://127.0.0.1:5173/`, including local scripts and assets.
Limits: 1,000 requests, 300 seconds maximum, no supplied credentials, no POST.

## Observed evidence

- Run `d323926e-f60d-4591-8f3e-b846c1e1da1b`: 341 requests, four requested pages, partial. Anonymous visitors reach onboarding; an email-field readiness selector was inappropriate for that initial screen.
- Run `8f28c561-d007-47f3-9d49-4b5dddff74b5`: 522 requests, partial. SPA flow navigated to `/auth?skip_welcome=1&tab=signin` and verified `#signin-email`, `#signin-password`, and `[data-testid="signin-submit-btn"]`. All four steps completed; this is evidence that the login UI rendered, not a successful login.
- Vite WebSocket requests were blocked. Some assets failed. The browser has a cumulative 20 MB response budget and a 2 MB per-response limit; the development bundle and media approach this budget. Failed-request evidence currently uses a generic message, so individual failures cannot be attributed conclusively from the saved report.
- No successful authenticated API access or authorization result was established. HTTP 200 for an SPA route alone is not proof that its protected content loaded.
- The application client is configured for `https://loepcagitrijlfksawfm.supabase.co`, outside the local-only scope. Loam currently requires one origin for login, POST and account flows. A deliberate API-origin integration or a same-origin test proxy is required before authenticated testing can work end to end.

## Prepared login recipe (requires the API-origin issue to be resolved first)

```json
[
  {"action":"navigate","path":"/auth?skip_welcome=1&tab=signin"},
  {"action":"fill","selector":"#signin-email","secretRef":"ownerEmail"},
  {"action":"fill","selector":"#signin-password","secretRef":"ownerPassword"},
  {"action":"click","selector":"[data-testid=\"signin-submit-btn\"]"},
  {"action":"assertVisible","selector":"nav[aria-label=\"Primary navigation\"]"}
]
```

The navigation assertion verifies landing UI, not account identity. Multi-account tests additionally need an exact visible identity witness on a profile page.

## Required test data

1. Two existing, verified email/password test accounts, A and B, with separate identities and the same ordinary role. Optional third account with an elevated role for vertical authorization checks.
2. Each account's expected visible identity text and profile selector. Use synthetic test identities.
3. A synthetic record owned by A, its exact read-only API path, and a unique expected marker; B must be denied. Prefer a reciprocal record owned by B as a second case.
4. Exact allowed/denied role matrix and any onboarding requirements. If OTP/MFA is required, describe the test login mechanism; do not disable production security.
5. Confirmation of which Supabase project is the designated test backend and whether it contains only test data. Do not supply a service-role key: it bypasses the authorization being tested.

Enter credentials into Loam's temporary values field when the backend scope is configured. Do not use the existing personal browser session. Retests must reuse the same scope, account identities, record markers and expected permissions with fresh credentials; failures to log in remain inconclusive.

Evidence: `output/verification/nutrio-assessments.json`. Screenshots of target pages were disabled to avoid capturing personal health data.
