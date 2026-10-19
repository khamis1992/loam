# Security workspace

Open **الأمن السيبراني واختبار الاختراق الذاتي** in the sidebar (`/#/studios/security`).
Select an existing task to assess its isolated source folder, or create a new assessment task for an HTTP target. A new task has no source files until files are added through the task workspace.

Choose a campaign or direct assessment, enter authorized targets, acknowledge authorization for all assets, and start. The server discovers scoped pages, constructs its check plan, records evidence, and produces a report without an LLM dependency. Reports export as Markdown, JSON and SARIF 2.1.0. Progress, cancellation, finding owners/notes, accepted risks and baseline retests are available in the workspace.

## Coverage

- Response security headers, cookie flags, technology disclosure, five bounded file probes, directory-index signatures, CORS, advertised HTTP methods and TLS certificate/trust inspection.
- Campaign discovery follows static HTML anchors within approved origin/path prefixes. OpenAPI JSON imports contribute concrete GET paths within the same approved scope; document servers, templated paths and write operations are ignored. Pages also receive CSP, diagnostic disclosure, mixed-content and password-form checks. POST forms without recognizable CSRF fields generate an informational review signal, not a confirmed CSRF finding.
- Optional bearer/cookie sessions remain in memory for the current campaign. Authenticated campaigns allow exactly one origin. Credentials are cleared from the form after submission and not saved in reports. Explicitly declared protected routes are compared with/without the session; identical successful content is flagged for manual authorization review. This does not establish session validity or exploitability.
- Source heuristics for routes, hardcoded credentials, dynamic execution and HTML assignments. At most 200 source files, 300 KB each; dependencies, generated folders and links are skipped. These are review signals, not confirmed vulnerabilities.
- npm lockfile v2/v3 inventory detects HTTP downloads and missing integrity hashes. Optional OSV queries send **only package names and exact versions**, up to 1000 unique packages, to the fixed OSV endpoint. No source, lockfile contents, target URLs or auth headers are sent. [OSV batch API](https://google.github.io/osv.dev/post-v1-querybatch/) returns advisory identifiers without severity; these matches are explicitly unranked until reviewed for applicability. Pagination or outages mark the lookup incomplete, never clean.
- Basic HTTP responses are capped at 32 KiB. Static discovery rejects query-string URLs. Redirects, encoded paths, out-of-scope origins, excluded paths and action-like endpoints such as logout/delete are not followed. Each request is timeout-bound. The campaign has a shared request budget, delay, page/depth limits and a total deadline. Non-success responses are inconclusive except expected file-probe denial/not-found responses. Unconfigured form submission, arbitrary exploit execution, port scanning and comprehensive TLS cipher enumeration are not implemented.

## Real browser verification

### Verified sessions and multiple-account authorization

The browser configuration now accepts `accounts` (maximum 5) and `authorization` cases (maximum 10, 40 account/case pairs). Both are editable in the browser panel; **مصفوفة الصلاحيات** displays expected/observed outcomes, session validity, positive controls, request IDs and screenshots. No accounts or application data are provisioned automatically.

Each account specifies an `id`, declarative `login` steps, and an identity `witness` with `path`, CSS `selector`, and `textRef`. The visible identity text must exactly match the fresh value in `browserSecrets`. Expected identities must be distinct. An optional `bearerRef` supplies an account-specific token for API requests. Account contexts never inherit the global bearer/cookie or another account's session. Cookie, localStorage and sessionStorage snapshots stay in memory.

Example account (repeat with different IDs and secret references for the second account):

```json
{
  "id": "owner",
  "login": [
    {"action":"navigate","path":"/login"},
    {"action":"fill","selector":"#username","secretRef":"ownerUser"},
    {"action":"fill","selector":"#password","secretRef":"ownerPass"},
    {"action":"click","selector":"button[type=submit]"},
    {"action":"assertVisible","selector":"[data-identity]"}
  ],
  "witness":{"path":"/account","selector":"[data-identity]","textRef":"ownerIdentity"}
}
```

Example permission cases:

```json
[
  {"id":"owned_record_api","kind":"api","path":"/api/records/test-record","markerRef":"recordMarker","allowed":["owner"],"denied":["other"]},
  {"id":"owned_record_ui","kind":"ui","path":"/records/test-record","selector":"[data-private-record]","deniedSelector":"[data-access-denied]","allowed":["owner"],"denied":["other"]}
]
```

API cases send a scoped GET from the isolated account browser context and look for a known protected test-data marker, supplied through `browserSecrets`. A 2xx status alone does not prove exposure. UI cases use visible protected/denial selectors. Every case requires disjoint, explicit allowed and denied account groups; all allowed-account controls must succeed before a denied-account result is conclusive. Identity is rechecked before and after each observation. Explicit 401/403 or a configured UI denial is required to establish prevention; missing content, failed requests, invalid identities and expired sessions stay inconclusive.

Application readiness waits for document completion, bounded network settling and a **visible** configured readiness selector. Without that selector, the report explicitly describes transport-only readiness. Blocked/failed resources and runtime errors prevent complete browser coverage. Readiness is limited to the supplied witnesses and observation window, not a proof that every possible app workflow is loaded.

Per-account request evidence contains `accountId`. Proofs preserve test policy, session outcomes, status and positive-control linkage, never raw response content or passwords. Reports include planned/conclusive/inconclusive case counts. UI evidence can include masked screenshots; API evidence uses response digests and marker-match booleans. Retests require fresh secrets and preserve the exact case policy. Salted digests of identity/data witnesses prevent changing those expected values during a retest while still permitting new passwords/tokens. Changed identities or test records require a new baseline.

`npm run check:security-accounts` verifies two isolated identities against vulnerable/fixed/outage/expired-session fixtures for both API and UI permission cases. The HTTP/Chrome UI suite configures accounts, executes a permission case, reads the matrix and evidence, retests and verifies persistence.

### Login, SPA flows and POST APIs

The browser panel supports declarative `login` steps and up to five named `flows` (30 steps each). A step is `navigate` with a scoped relative `path` (including a SPA hash route), `click` with a CSS `selector`, `fill` with a selector and `secretRef`, or `assertVisible` with a selector. Each login/flow ends with a visible-element assertion. Explicit clicks exercise the application's own JavaScript and API requests; there is no arbitrary script step. Define a final selector that appears only when the intended operation succeeds.

Example login:

```json
[
  {"action":"navigate","path":"/login"},
  {"action":"fill","selector":"#username","secretRef":"username"},
  {"action":"fill","selector":"#password","secretRef":"password"},
  {"action":"click","selector":"button[type=submit]"},
  {"action":"assertVisible","selector":"[data-account]"}
]
```

Pass values separately as assessment `browserSecrets: {"username":"test-user","password":"..."}`. All field values use references, including nonsecret search inputs; they are not saved with the flow. Supply them again on retest. Cookies, localStorage and sessionStorage established by login are kept in memory and restored in isolated authenticated browser contexts; anonymous access witnesses receive none of that state. Login failure prevents subsequent authenticated browser testing. This session applies to browser checks, not the separate HTTP engine. Interactive MFA, CAPTCHA, federated external login and automatic identity-provider discovery are not implemented.

`browser.postPaths` is an explicit allowlist of at most 20 **exact paths**, with no query or fragment. It requires one approved origin. A permitted path can send POST bodies up to 64 KiB; every request still passes scope/exclusion and shared budget checks. The API permission covers all POST operations on that path, including GraphQL operations; it is not an operation-level authorization policy. Use test accounts and suitable endpoints because POST and explicit clicks may change application data. PUT/PATCH/DELETE and undeclared POST remain blocked. Evidence includes method, allowlisted path, request byte count, response digest/status and proof linkage, never request bodies or auth headers.

`browser.followRedirects` enables scoped document redirects. To prevent Chromium redirect continuations bypassing interception, a controlled navigation bridge follows them as fresh intercepted GET requests. POST-preserving 307/308 and fetch/XHR redirects remain blocked. Native POST/303 login is supported. Every destination is checked again; external identity providers must not be assumed to work.

Named flows run independently from the same authenticated snapshot. Rendered DOM checks use stable flow-specific keys for retest comparison. Evidence records completed steps, expected selectors and relevant request IDs. A failed flow or unavailable login keeps previous observations unverified. A successful visibility assertion is evidence that the flow worked, not proof that its API authorization is secure. Protected-element comparisons remain available separately.

Enable **متصفح فعلي والتحقق من الثغرات** to render JavaScript in an isolated, temporary headless Chromium context. Installed Playwright Chromium, Chrome or Edge is required. The engine/version, rendered links/forms, request evidence, blocked requests and test outcomes appear under **أدلة المتصفح**. Rendered static-path links join the HTTP check plan. This is bounded discovery, not exhaustive SPA crawling: query/hash navigation links and user interaction flows are not followed.

Optional probes:

- **DOM canary:** a fixed image error handler in `location.hash` sets one random local DOM attribute. It neither reads application data nor sends a payload to the server. Execution confirms this specific fragment-to-HTML path; a negative result does not exclude other XSS sources, sinks or encodings.
- **Framing:** a synthetic cross-origin page attempts anonymous embedding. A finding records successful rendering, not demonstrated clickjacking impact. A negative requires an explicit browser-enforced framing denial.
- **Protected UI assertions:** supply `path | protected CSS selector | denial CSS selector` and fresh bearer/cookie credentials. Separate authenticated and anonymous browser contexts compare visible elements. An authenticated positive control and explicit anonymous denial are required for a negative. This verifies the declared UI witness; API authorization still needs review.

Browser resources may carry query strings under approved origin/path prefixes; sensitive action query keys are rejected and query values are omitted from stored evidence. All target requests pass a shared serialized budget through intercepted, bounded Node fetches; a deny-only local proxy blocks browser network paths bypassing interception. GET, HEAD and OPTIONS are allowed, with explicit POST and document-redirect options described above. WebSocket, service workers, downloads and popups remain blocked. Applications needing external CDNs or WebSockets can therefore be partially evaluated. GET endpoints with side effects must be excluded by the operator.

Defaults are 5 rendered pages and a 750 ms settle window; limits are 10 pages, 250–5000 ms, 2 MB per browser resource and 20 MB total browser response bytes. An optional readiness selector can identify when the app is ready. Missing resources, runtime failures and budget exhaustion preserve incomplete coverage.

Optional PNG evidence is saved under `.loam/security-artifacts/<runId>/`, with a SHA-256 manifest. Inputs, editable fields and text containing supplied session values are masked before capture; other application data may remain visible. No raw DOM or response bodies are persisted. Each finding references proof IDs and request IDs. Artifact reads validate the digest and stay within the selected task. Retests preserve browser settings and require fresh credentials; unavailable tests remain unverified rather than declaring a fix.

`browser` in the assessment POST accepts `{enabled, domCanary, framing, screenshots, maxPages, settleMs, readySelector, accessAssertions: [{path, selector, deniedSelector}], postPaths, followRedirects, login, flows}`. Read screenshots through `GET /api/security/assessments/<id>/browser-evidence/<proofId>?taskId=<id>`.

## Campaign settings

Defaults: 20 pages, 200 HTTP requests, 200 ms between requests, depth 2, and 180 seconds total. Limits: 10 seed URLs, 100 pages, 1000 requests, 5 link levels, 900 seconds and 20 declared protected paths. Exact origin and path-prefix checks occur before outbound target HTTP requests. TLS inspection runs once per discovered origin; file probes run only at seed paths. Advisory requests are separate from target HTTP telemetry and have their own bounded batch/response limits.

Every HTTP evidence record contains time, method, URL, status, duration, content type, byte count and SHA-256 of the bounded response. Raw response bodies and credentials are not retained. Findings reference the relevant request IDs. Source signals and advisory matches are also included in the findings workflow.

## Remediation and retest

Findings use stable fingerprints and can be open, under review, or accepted risk, with an owner and note. Updates require an expected revision; conflicting edits return 409. Notes must not contain passwords or tokens.

Retests preserve the baseline scope, selected checks, discovery inputs and authentication mode. Authenticated retests require fresh credentials. They retain existing triage and classify observations as new, persistent, not observed again, or unverified. A missing observation is only classified as not observed when that target/check actually completed without an error. Cancelled, inaccessible, undiscovered and untested observations remain unverified. Source/dependency disappearance currently remains unverified rather than automatically claiming a fix. Manual workflow status never declares a vulnerability verified fixed.

## Persistence and API

Assessments are atomically saved under the selected task's `.loam/security/<uuid>.json`. One assessment can run per task and at most three globally. Restarted unfinished runs appear as interrupted; completed evidence remains available. Cancellation preserves completed checks. Time/request limits, unavailable checks, incomplete advisory results and page-limit truncation produce a partial status. The UI polls while a campaign is active; closing the UI does not stop the server job. Older reports are normalized in memory when read.

All routes require `?taskId=<id>`:

- `GET /api/security/assessments`: history (latest 50) and checks.
- `POST /api/security/assessments`: `{target, authorized, profile, checks, scope, auth, openapi, protectedPaths, includeSource, includeDependencies, queryAdvisories}`. `scope` accepts `{seeds, exclusions, maxPages, maxRequests, maxDepth, delayMs, timeoutSeconds}`; `auth` accepts `{bearer, cookie}`.
- `GET /api/security/assessments/<id>`: progress and evidence.
- `POST /api/security/assessments/<id>/cancel`: cancel.
- `GET /api/security/assessments/<id>/report`: Markdown download.
- `GET /api/security/assessments/<id>/sarif`: SARIF download.
- `POST /api/security/assessments/<id>/triage`: `{fingerprint, expectedRevision, state, owner, note}`.
- `POST /api/security/assessments/<id>/retest`: `{authorized, auth, queryAdvisories}`. The server retrieves the baseline settings rather than accepting a modified test scope.

Mutations require JSON and reject cross-origin browser requests. File access stays within the task workspace. Potential credential evidence is redacted. Exported results should still be handled as internal security reports.

## Validation

`npm run check:security` exercises a local HTTP fixture, errors, redirects, redaction, isolation, cancellation and restart interpretation.

`npm run check:security-campaign` exercises link/OpenAPI discovery, origin/path boundaries, exclusions, credential containment/redaction, budgets, optimistic triage, fixed vs unavailable retests, SARIF and OSV batch/error contracts against controlled fixtures.

`npm run check:security-http` starts an isolated Loam server and local target, tests API validation and report exports, drives the workspace using installed Chrome including triage and retest, then restarts the server to check persistence. It does not scan external systems.

`npm run check:security-browser` runs vulnerable/fixed/unavailable local JavaScript fixtures in an actual browser. It checks rendered discovery, DOM execution, frame restrictions, authenticated/anonymous witnesses, retest classifications, PNG integrity, egress/write blocking, concurrent request budgets and cancellation. The HTTP suite also exercises the browser UI and task-isolated screenshot API.

`npm run check:security-flows` verifies native POST login, multiple cookies, controlled redirect, SPA hash navigation, JSON POST with bearer/CSRF, secret redaction, isolated anonymous sessions, fixed/unavailable retests, and blocking undeclared POST/external redirects against local fixtures.

`npm run check:security-osv` is an opt-in network smoke test against live OSV using only a fixed public package (`lodash@4.17.20`), without reading project dependencies.
