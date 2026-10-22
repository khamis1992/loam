# Mobile Studio: unified runtime and local services

Authorized request: unify source and preview, simplify the builder while preserving Loam colors, complete local services, and verify a complete journey with a real local model.

## Execution order

1. Use generated web source as the single saved preview/publish runtime. Keep screen navigation and click editing through an explicit sandbox bridge. Draft schema edits use the same renderer; source edits refresh the standard preview. Diagnose runtime errors visibly. Prevent silently stale generated overrides.
2. Reduce surrounding chrome, consolidate controls, make preview dominant, improve empty conversation context and filter non-generative models. Keep responsive navigation, accessibility, undo and colors.
3. Add task-scoped SQLite services: validated records/values, migrations, authentication/session/user lifecycle, owner permissions, bounded local file storage and encrypted secrets. Connect generated preview and management UI to these services. Preserve existing browser data through explicit import, never silently erase it. Expose useful bounded server operations and logs rather than arbitrary execution.
4. Run focused runtime/service tests plus existing mobile integration checks. Build and restart only the owned 3941 instance. Build a new app with qwen2.5:14b and verify child navigation/back, edit/reload persistence, source edit, undo/version restore, authentication, records and local release.

## Ownership

- Root: unified runtime, source/preview bridge, HTTP integration and final live journey.
- Frontend specialist: compact builder layout and local service management UI, coordinated via agreed API.
- Local backend specialist: isolated SQLite backend, auth/files/secrets and service tests. No changes to the shared main HTTP file; root wires its handler.

## Completion criteria

- One default preview displays saved code changes and design changes, supports screen selection/click edit, and matches published runtime.
- Existing Rafiq project data stays intact; unknown custom source conflicts are explicit.
- Local services actually persist and enforce isolation; UI accurately reflects capabilities.
- Evidence distinguishes deterministic tests from the real local-model journey.

## Completion evidence

All four steps completed on 2026-10-18. The bundled mobile suite, typecheck, generation/data-review checks and local-services acceptance passed. The live 3941 journey generated a nine-screen app with qwen2.5:14b, verified nested navigation and saved records, exercised source editing/undo and created a working local release. The model required iterative repair and a follow-up for its omitted collection. See docs/mobile-unified-runtime-verification.md for precise results and boundaries.
