/**
 * Static template strings for the scaffold_backend "supabase" kind.
 *
 * Kept as TypeScript string exports (not raw files on disk) so esbuild bundles
 * them into the dist server build; runtime file loading would break the
 * packaged desktop app.
 *
 * Safety invariants preserved across every template:
 *  - .env.example values are ALWAYS empty (`NAME=`), placeholder names only.
 *  - No network I/O and no SDK imports in generated TypeScript; real wiring is
 *    marked with TODOs.
 *  - No secret-shaped literals (sk_live_/sk_test_/whsec_/JWT blobs) anywhere.
 */

export const SUPABASE_MIGRATION = `-- Supabase starter schema (extensible row-ownership example).
-- Run with: supabase migration new <name>  (then paste DDL here)
create extension if not exists "uuid-ossp";

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Example domain table; adjust to your project.
create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references app_users(id) on delete cascade,
  title text not null,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists items_owner_id_idx on items (owner_id);
create index if not exists items_status_idx on items (status);
`;

export const SUPABASE_TRIGGER_MIGRATION = `-- Kept-timestamp trigger: bumps updated_at on every UPDATE.
CREATE OR REPLACE FUNCTION set_public_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS app_users_updated_at ON app_users;
CREATE TRIGGER app_users_updated_at
  BEFORE UPDATE ON app_users
  FOR EACH ROW EXECUTE FUNCTION set_public_updated_at();

DROP TRIGGER IF EXISTS items_updated_at ON items;
CREATE TRIGGER items_updated_at
  BEFORE UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION set_public_updated_at();
`;

export const SUPABASE_RLS_POLICY = `-- Row-level security stub. Review every line before shipping; these are
-- opinionated defaults for owner-scoped data, not a security audit.
-- Requires the Supabase auth.uid() helper function (present in every project).

-- 1) Enable RLS on every table.
alter table app_users enable row level security;
alter table items enable row level security;

-- 2) app_users: a user can read and update their own row only.
--    RLS does NOT apply to table owners (the rider "elevated" role) -- service
--    calls must go through the service-role key and stay server-side.
create policy "app_users select own"
  on app_users for select
  using (id = auth.uid());

create policy "app_users update own"
  on app_users for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- 3) items: owners see and modify their own rows.
create policy "items select own"
  on items for select
  using (owner_id = auth.uid());

create policy "items insert own"
  on items for insert
  with check (owner_id = auth.uid());

create policy "items update own"
  on items for update
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy "items delete own"
  on items for delete
  using (owner_id = auth.uid());

-- 4) TODO: add read-everyone policies only if the data is truly public, e.g.:
--    create policy "items select published"
--      on items for select
--      using (status = 'published');
--
-- 5) TODO: verify with two different anon tokens that one user never sees
--    another user's rows, and that insert with a forged owner_id is rejected.
`;

export const SUPABASE_SEED = `-- Local-dev seed data. Idempotent: inserts only when the row is missing.
insert into app_users (id, email)
select '00000000-0000-0000-0000-000000000001', 'seed-user@example.test'
where not exists (select 1 from app_users where id = '00000000-0000-0000-0000-000000000001');

insert into items (id, owner_id, title, status)
select '00000000-0000-0000-0000-000000000002',
       '00000000-0000-0000-0000-000000000001',
       'Example item (replace me)', 'draft'
where not exists (select 1 from items where id = '00000000-0000-0000-0000-000000000002');
`;

export const SUPABASE_CLIENT = `// Supabase client init. Fill SUPABASE_URL and SUPABASE_ANON_KEY in .env
// (see .env.example). No credentials belong in source files.
// TODO: npm install @supabase/supabase-js
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Server-only key. NEVER interpolate into browser bundles and never accept it
// from a client request; TODO: load from a secret manager in production.
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

export function getSupabaseConfig(): { url: string; anonKey: string } {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set in the environment (.env.example)");
  }
  return { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY };
}

/**
 * Creating the typed client is behind a TODO so this stub performs no imports
 * and no network I/O. Typical wiring once @supabase/supabase-js is installed:
 *
 *   import { createClient } from "@supabase/supabase-js";
 *   export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
 */
export function noteSupabaseWiringTodo(): string {
  return "wire createClient from @supabase/supabase-js here";
}

/**
 * Refusal-safe helper: service-role calls (bypass RLS) must only be attempted
 * when an explicit env key exists. Returns null instead of a half-configured
 * client so callers fail clean.
 */
export function getServiceRoleKeyOrNull(): string | null {
  return SUPABASE_SERVICE_ROLE_KEY ?? null;
}
`;

export const SUPABASE_README = `# Supabase starter (scaffold_backend)

Generated files:

- \`migrations/0001_init.sql\` - schema (users + ownership example)
- \`migrations/0002_triggers.sql\` - updated_at triggers
- \`policies.sql\` - row-level security stub (review before shipping)
- \`seed.sql\` - idempotent local-dev data
- \`../src/lib/supabaseClient.ts\` - env-driven client init stub

## Setup steps

1. \`npm install @supabase/supabase-js\`
2. Create a project at supabase.com, then copy values into \`.env\`
   (start from \`.env.example\`; every generated value is empty on purpose).
3. Apply migrations + seed:

   \`\`\`sh
   supabase init        # once
   supabase link --project-ref <ref>
   supabase db push     # migrations/0001_init.sql, migrations/0002_triggers.sql
   psql "\\$SUPABASE_URL" -f supabase/policies.sql   # or run via dashboard SQL editor
   psql "\\$SUPABASE_URL" -f supabase/seed.sql       # dev data only
   \`\`\`

4. Copy the anon key and URL into your server env. Keep the service-role key
   server-side ONLY.

## RLS checklist

- policies.sql enables RLS on every table, owner-scoped by auth.uid().
- Add explicit "public read" policies only for data that is truly public.
- Test with two users: one can never read the other's rows.
- Service-role access bypasses RLS: use it sparingly and never from the client.
`;
