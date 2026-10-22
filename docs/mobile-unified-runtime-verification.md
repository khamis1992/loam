# Mobile Studio unified runtime and local services

Date: 2026-10-18. Preview instance: http://127.0.0.1:3941/ . Only this task's server was restarted; other Loam instances were preserved.

## Delivered architecture

The default preview compiles the saved web/index.html, web/styles.css and web/app.js through the same source-preview endpoint used by immutable local releases. One opaque sandbox and one host bridge handle visual screen selection, click editing, source execution, storage and errors. Current project metadata is injected separately so saved JavaScript overrides do not freeze old titles or navigation. Offline web exports use the same renderer; Expo and Kotlin files remain separate export/build targets.

The builder has a compact header and toolbar, a dominant phone preview, collapsible chat, a centered new-project prompt and responsive fallback controls. Existing Loam green colors remain. Embedding no longer repeats the outer navigation/header above the studio. Embedding and non-generative models are excluded from the build selector. Conversation updates preserve reading position and follow the latest reply when appropriate. Syntax highlighting is assembled off-DOM and painted on the next animation frame, fixing a 46 KB paste that previously blocked input for over 30 seconds.

Task-scoped SQLite stores validated records and input values, local users, hashed passwords and session tokens, access policy, file metadata, audit events and project knowledge. Local files are bounded and scoped; AES-GCM encrypts secrets. The management UI provides actual users/session controls, data policy, files, redacted secret names, logs, knowledge and real service activity counts. Generated apps use bounded named operations through the host; administrative capabilities and tokens are not sent into generated source or model prompts. Project-authored knowledge alone is included in generation context.

Legacy browser data requires explicit import into an empty shared scope. SQLite caches are marked to prevent private account data being treated as legacy data during policy changes. User scope is always derived by the server.

## Automated verification

- npm run typecheck: passed.
- npm run build:server: passed.
- npm run check:mobile -- --bundle: passed including 40-screen hierarchy, source CAS and undo/redo, saved CSS and JavaScript in the default preview, later visual title changes retaining custom JavaScript, records, local publication after undo/redo with the editor hidden, Git, real scoped PTY, responsive 320px layout and unified local services browser acceptance. Final test workspace: C:/Users/khamis/AppData/Local/Temp/loam-mobile-test-gcZr6E.
- npx tsx src/scripts/check-mobile-build.ts: passed, including project knowledge injection and exclusion of secret values.
- npx tsx src/scripts/check-mobile-data-review.ts: passed, including empty removal-audit grammar when no draft rules exist.
- npx tsx src/scripts/check-mobile-local-services.ts --http: passed direct service and HTTP tests, including session expiry/revocation/disable/throttle, owner isolation, conflict handling, files, encrypted secrets and audit persistence.
- npx tsx src/scripts/check-mobile-unified-services.ts: passed actual sandbox register/login/logout, two-user and same-browser account switching, values/records/files isolation, upload/download byte comparison, browser cache forgery rejection, SQLite reload after cache removal and policy roundtrip.

The browser test exposed and verified fixes for native form submission blocked by sandbox, duplicate session initialization and private SQL caches being mistaken for legacy data. Saving fields now awaits the server acknowledgement before reporting success. Manual testing also found a stale source tag when publishing after undo with the editor hidden; publication now obtains a fresh tag from saved source. One intervening suite run had an intermittent checkbox-click failure; a clean rerun passed the entire suite, including persistence of that checkbox. This was not reproduced in the final run.

## Live project preservation

Rafiq task task_mvdb5dyx6cb1a5e47e9a remains revision 14 with 20 screens. Its legacy browser values were explicitly imported through the database panel. The details field remained “تجهيز عرض المشروع ومراجعة النتائج”. Proof: release/mobile-live/unified-review/rafiq-preserved.png.

## Boundaries

This is the existing mobile schema renderer with executable saved web source, not a general React/npm bundler. Native outputs were syntax/export checked; no new iOS device or Android signing claim is made. Server functions are named record operations. Local publication is served by Loam on this computer. Release web files are immutable; local services still validate against the current project data schema. Secrets stay in the local vault; arbitrary generated code cannot read their values. Analytics reflects local backend events, not visitors. Workspaces still list partial external integrations accurately.

## Real local model journey

Actual browser-driven generation used Ollama qwen2.5:14b, not a fixture. The fresh project is task_mve1frhy698f65f74275, titled “مسار الإنجاز”. The first nine-screen build was rejected after three repair attempts (duplicate block IDs, missing forward links, then an invented removed-rule audit). No partial invalid project was committed. The review grammar was tightened to constrain removedRules to the actual number of draft rules.

A second explicit request produced revision 2 after bounded repairs: three primary sections and six nested pages, with all six forward links and back navigation. The model omitted the requested task collection; an explicit follow-up added it on its first attempt at revision 3, preserving the nine screens. This is a successful iterative journey, not a claim of complete generation from a single prompt.

Manual browser checks visited daily → plan → focus, projects → goals → step, and review → weekly → lesson. Back navigation returned through the correct parents. A plan note was saved and remained after navigation, reload, source editing and undo. A task “مراجعة النموذج الأولي قبل التسليم” was created, reloaded, edited to completed and verified in the database panel as “مكتملة · نعم”. A saved CSS change appeared in the default preview; undo restored the source without losing records. Current revision 5 includes that source undo.

Local release aefe77b6-4225-47a0-b078-8badbc2efa44 was created through the UI. Its application loaded and displayed the same completed record. URL: http://127.0.0.1:3941/mobile-published.html?taskId=task_mve1frhy698f65f74275&releaseId=aefe77b6-4225-47a0-b078-8badbc2efa44 .

Evidence in release/mobile-live/unified-review/: model-journey.json (actual saved schema and SQLite state), final-builder.png, model-sqlite-record.png, published-model-app.png and rafiq-preserved.png. Account creation/login/logout, account isolation, file upload/download, secret persistence and version restore were separately verified with synthetic users in the automated isolated test workspace, not claimed as actions performed by the local model.
