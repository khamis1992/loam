# Fast assessment diagnosis — 2026-10-18

The observed user assessment was `6127d214-dd46-4207-822e-2dfda30e08e1`, served by the local Loam instance on port 3941. Its authorized target was `http://127.0.0.1:5173/nutrio/dashboard`.

- Started at 03:38:29.575 UTC, finished at 03:38:31.833 UTC: 2.258 seconds.
- 12 HTTP requests, one discovered page, eight selected HTTP/TLS checks.
- No browser configuration stored in the original report. Normalized settings show browser disabled, no login, SPA flows or POST rules.
- Source assessment processed zero files; dependency inventory found zero locked packages. The task folder is separate from the application's source repository.
- The live target returns a SPA shell with zero anchor tags. JavaScript entry points are `/@vite/client` and `/src/main.tsx`, outside the original approved path prefix.

A diagnostic rerun using the current browser engine and **the unchanged target scope**, without DOM canaries, frame tests, credentials, POST or form interaction, produced `481e9200-e01d-4d7d-8261-522ab4051088`. Chrome started successfully. Eight resources were blocked as outside scope, including the entry scripts, fonts and React refresh. The result was correctly partial. Evidence is under `output/verification/security-diagnosis/.loam/security/`.

This establishes that the browser engine is connected and runnable in the current code. It does not establish that it ran in the original campaign. The original campaign completed its limited selected plan; its maximum duration was not a minimum runtime.

Corrections:

- Execution diagnostics expose duration, request count, each module's enabled/executed state, empty input sets and narrow-scope warnings, including for historical reports.
- Empty selected source/dependency assessments now produce partial results rather than an unqualified completed state.
- The UI shows the proposed execution plan before starting and requires a compatible server capability revision for browser campaigns.
- Tests cover empty input classification, diagnostics and the UI/server capability connection.

The source and built server require the active application process to reload before the new backend diagnostics become available. No running user application was stopped during diagnosis. Future full-application campaigns need explicit scope entries covering the application's resources/API, selected browser probes, actual login/SPA steps, and source/lockfiles in the assessment task. Scopes were not widened during investigation.
