# ft7 Report — FRONTIER W2 deepen: Supabase/DB + Stripe scaffolding

## What was done

The existing `scaffold_backend` generator (`src/tools/backendScaffold.ts`) was deepened from a minimal
3-file-per-kind stub into a complete, hyper-functional Supabase + Stripe scaffold, with the template
payloads extracted into a new **templates dir** `src/tools/templates/backend/`
(`supabaseTemplates.ts`, `stripeTemplates.ts`, `dbTemplates.ts`) — kept as bundled TypeScript string
modules so esbuild still bundles them into `dist/server.cjs` (no runtime file loading, so the packaged
desktop build stays intact).

### Supabase kind (now 7 files)
- `supabase/migrations/0001_init.sql` — schema with `app_users` + owner-scoped `items` (status column, owner/status indexes)
- `supabase/migrations/0002_triggers.sql` — `set_public_updated_at()` trigger function + per-table `updated_at` bump triggers
- `supabase/policies.sql` — **RLS stub**: enables RLS on every table and emits owner-scoped `auth.uid()` policies (select/insert/update/delete) with TODO markers for public-read policies and two-user leak verification
- `supabase/seed.sql` — idempotent seed data (`where not exists` guards)
- `src/lib/supabaseClient.ts` — env-driven client init; adds `SUPABASE_SERVICE_ROLE_KEY` handling via `getServiceRoleKeyOrNull()` (returns null rather than half-configuring; warns it must stay server-side)
- `supabase/README.md` — setup steps (`supabase init/link/db push`, applying policies/seed) + RLS checklist

### Stripe kind (now 6 files)
- `src/lib/stripeCheckout.ts` — unchanged checkout stub (existing behavior preserved)
- `src/lib/stripePlans.ts` — plan catalog mapping `free`/`pro` to env-backed price ids (`STRIPE_PRICE_ID_PRO`, `STRIPE_PRICE_ID_BASIC`) so business code never hardcodes price ids
- `src/lib/stripeWebhook.ts` — webhook skeleton: `prepareWebhookEvent()` returns **null (fail-clean) unless `STRIPE_WEBHOOK_SECRET` is set**, `describeEventAction()` maps the standard `checkout.session.completed` / `customer.subscription.*` events; real `constructEvent` verification is a scoped TODO
- `scripts/stripeSetup.ts` — runnable offline skeleton: `buildSetupChecklist()` validates which env vars are missing and prints the exact products/prices/webhook setup sequence (no API calls)
- `docs/stripe-setup.md` — setup README incl. the "raw request body" webhook-verification rule
- `.env.example` — now includes all six placeholder names; every value still empty

### Safety invariants (unchanged/enforced)
- `.env.example` values are placeholder names only (`NAME=`), structurally cannot embed a real key
- generated TypeScript performs no network I/O and contains no SDK imports (TODO-gated)
- no secret-shaped literals (`sk_live_`/`sk_test_`/`pk_live_`/`whsec_`/JWT/long base64 blobs)
- `projectDir` confinement via `resolveScaffoldDir` and blanket no-overwrite are intact and now also
  covered against every *new* deep file

## Tests
- New focused suite `src/tools/__tests__/backendScaffoldDeep.test.ts` (6 tests): full supabase file set
  content assertions (RLS/seed/triggers/README), client env reading + placeholder service-role key,
  full stripe file set (webhook fail-clean + plans + setup script + setup README), secret/network
  invariants across all generated files, no-overwrite for the new deep files, and exact
  `filesFor()` listings.
- Existing suites untouched and green: `backendScaffold.test.ts` (8), `backendScaffoldExposure.test.ts`,
  `runTools.test.ts`.
- Full sweep: `npx tsx --test src/{tools,server,modes}/__tests__/*.test.ts` → **322/322 pass**.

## Verification
- `npx tsc --noEmit` (root): 0 errors
- `npx tsc --noEmit -p packages/web/tsconfig.json`: 0 errors

## Commits (on mf/ft7)
1. `b36332f` feat(tools): deepen scaffold_backend — RLS/policies+seed+trigger migration (supabase), webhook+plans+setup script (stripe), templates dir (ft7)
2. (this one) test(tools): focused deepening tests for scaffold_backend (ft7)
3. (this one) docs/handoff: ft7 report

## Notes for siblings
- `filesFor()` is now exported (`export function filesFor`) — additive, no registry edits; tool
  registration in `src/index.ts` and `ALWAYS_ON_TOOLS` exposure in `runTools.ts` were already in place
  from the earlier W2 pass.
- Design decision to flag: templates are TS string modules rather than on-disk template files because
  the desktop build bundles the server with esbuild; a runtime-read templates dir would break
  `dist/server.cjs`.
