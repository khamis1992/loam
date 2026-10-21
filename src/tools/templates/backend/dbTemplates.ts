/**
 * Static template strings for the scaffold_backend "db" kind
 * (vendor-agnostic SQL migrations + DB client init).
 *
 * Same safety invariants as supabaseTemplates: empty .env.example values,
 * no network I/O, no secret-shaped literals.
 */

export const DB_MIGRATION = `-- Vendor-agnostic starter schema (PostgreSQL/SQLite compatible core).
create table if not exists users (
  id integer primary key autoincrement,
  email text unique not null,
  created_at timestamptz not null default now()
);

create table if not exists records (
  id integer primary key autoincrement,
  user_id integer references users(id) on delete cascade,
  payload json,
  created_at timestamptz not null default now()
);

create index if not exists records_user_id_idx on records (user_id);
`;

export const DB_CLIENT = `// Database client init. Set DATABASE_URL in .env (see .env.example).
// TODO: wire your driver of choice, e.g.:
//   npm install postgres            (then: import postgres from "postgres")
//   bun/tsx native: use node:sqlite for local-only prototypes.
const DATABASE_URL = process.env.DATABASE_URL;

export function isDbConfigured(): boolean {
  return Boolean(DATABASE_URL);
}

export function getDatabaseUrl(): string {
  if (!DATABASE_URL) throw new Error("DATABASE_URL must be set in the environment (.env.example)");
  return DATABASE_URL;
}
`;
