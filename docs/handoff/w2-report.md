# W2 Report — Backend scaffold generator (Supabase/DB + Stripe)

## Status
Complete. All work in scope, committed on branch `mf/w2`.

## Tool
`scaffold_backend` — new file `src/tools/backendScaffold.ts`

- **Request (args):** `{ kind: "supabase" | "db" | "stripe", projectDir?: string }` (projectDir relative to the task workspace, default `.`)
- **Response:** `{ ok: boolean, content: string }` — summary of created/skipped files.
- **Behavior:** offline starter-file generator (no network, no Rust/wasm dependency):
  - `supabase` → `supabase/migrations/0001_init.sql`, `src/lib/supabaseClient.ts`, `.env.example` (`SUPABASE_URL=`, `SUPABASE_ANON_KEY=`)
  - `db` → `migrations/0001_init.sql`, `src/lib/db.ts`, `.env.example` (`DATABASE_URL=`)
  - `stripe` → `src/lib/stripeCheckout.ts` (checkout stub, no SDK/network calls), `.env.example` (`STRIPE_SECRET_KEY=`, `STRIPE_PUBLISHABLE_KEY=`, `STRIPE_WEBHOOK_SECRET=`, `STRIPE_PRICE_ID=`)
- **Safety rules enforced:**
  - `.env.example` files contain placeholder variable names ONLY, every value empty — the tool structurally cannot embed a real key.
  - Generated TS reads `process.env` and never makes network I/O (asserted in tests against `fetch|axios|https?://`).
  - `projectDir` must resolve inside the task workspace (`resolveScaffoldDir` rejects absolute/`..`/drive paths); existing files are never overwritten.

## Registration
- Registered at boot in `src/index.ts` (`rt.registry.registerAll(createBackendScaffoldTools())`).
- Exposed to agent runs via `ALWAYS_ON_TOOLS` in `src/server/runTools.ts` (low-risk item).
- No HTTP routes needed (tool is agent-facing only) → **no http.ts edits, nothing to mount**.

## Tests
- `src/tools/__tests__/backendScaffold.test.ts` (8 tests): expected placeholders per kind, no secret-looking values (sk_live/sk_test/pk_live/whsec/JWT/long-base64 patterns), empty `.env.example` values, no network I/O, workspace confinement, no-overwrite.
- `src/server/__tests__/backendScaffoldExposure.test.ts` (4 tests): scaffold_backend appears in the effective run tool list through the gateway + always-on composition (per-agent `disabledTools` still removes it).
- `src/server/__tests__/runTools.test.ts`: minimal 2-line fixture update (registers the real scaffold tools alongside the other always-on tools, mirroring index.ts).

## Verification
- `npx tsc --noEmit` (root): 0 errors
- `npx tsc --noEmit -p packages/web/tsconfig.json`: 0 errors
- `node --test` suites (`src/server/__tests__`, `src/tools/__tests__`, `src/modes/__tests__`): 75/75 pass
- `npm run build` in `packages/web`: fails with the **known** worktree Turbopack `Could not find next/package.json` junction error (documented in task W2 notes; web tsc green instead).

## Commits (on mf/w2)
1. `7f1a639` feat(tools): scaffold_backend generator for supabase/db/stripe starter files (W2)
2. `6305d05` chore(runTools): allow scaffold_backend in ALWAYS_ON_TOOLS (W2)
3. `1512c56` chore(index): register backendScaffold tools at boot (W2)
4. `098a855` test(server): scaffold_backend appears in the effective run tool list (W2)
5. `705f6d2` test(runTools): register scaffold_backend in gateway exposure fixture (W2)
6. (this commit) report

## How to test live
1. Start the desktop/web app (`npm run dev`).
2. Create an agent (Ask/build mode), prompt it: "Use scaffold_backend with kind supabase to scaffold a backend in dir `my-app`".
3. Verify `my-app/supabase/migrations/0001_init.sql`, `my-app/src/lib/supabaseClient.ts`, and `my-app/.env.example` (empty values) appear; repeat for kinds `db` and `stripe`. Per-agent tool denial also works (uncheck or disable the tool).

## What's left / notes
- Generated stubs intentionally leave real SDK wiring (`@supabase/supabase-js`, `stripe`, `pg`) marked as TODOs — no network/install performed by design.
- No ArtCraft design references used; no brand assets; no NOTICE needed. Clean-room TypeScript only.
