/**
 * scaffold_backend: offline starter-file generator for backend scaffolds.
 *
 * Kinds:
 *  - "supabase": SQL migrations + schema, Supabase client init, .env.example
 *  - "db": vendor-agnostic SQL migrations + DB client init, .env.example
 *  - "stripe": Stripe checkout stub (no network calls), .env.example
 *
 * Safety rules baked into the generated content:
 *  - .env.example files contain PLACEHOLDER VARIABLE NAMES ONLY. Every value
 *    is empty; the tool can never embed a real key, token or URL.
 *  - Generated code only reads process.env; it never performs network I/O
 *    (Stripe/HTTP imports are stubbed behind typed TODOs).
 *  - Writes are confined to the task workspace; projectDir may not escape it
 *    and existing files are never overwritten.
 */

import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str } from "./registry.js";

type ScaffoldKind = "supabase" | "db" | "stripe";
const KINDS: readonly ScaffoldKind[] = ["supabase", "db", "stripe"];

interface ScaffoldFile {
  relPath: string;
  content: string;
}

const SUPABASE_MIGRATION = `-- Supabase starter schema.
-- Run with: supabase migration new <name>  (then paste DDL here)
create extension if not exists "uuid-ossp";

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  created_at timestamptz not null default now()
);

-- Example domain table; adjust to your project.
create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references app_users(id) on delete cascade,
  title text not null,
  created_at timestamptz not null default now()
);

-- Row-level security skeleton (enable/policies per table as needed):
-- alter table items enable row level security;
-- create policy "owner read" on items for select using (auth.uid() = owner_id);
`;

const DB_MIGRATION = `-- Vendor-agnostic starter schema (PostgreSQL/SQLite compatible core).
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
`;

const SUPABASE_CLIENT = `// Supabase client init. Fill SUPABASE_URL and SUPABASE_ANON_KEY in .env
// (see .env.example). No credentials belong in source files.
// TODO: npm install @supabase/supabase-js
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

export function getSupabaseConfig(): { url: string; anonKey: string } {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set in the environment (.env.example)");
  }
  return { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY };
}
`;

const DB_CLIENT = `// Database client init. Set DATABASE_URL in .env (see .env.example).
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

const STRIPE_CHECKOUT = `// Stripe checkout stub. Set STRIPE_SECRET_KEY / STRIPE_PRICE_ID in .env
// (see .env.example). This stub deliberately performs NO network calls:
// implement the real SDK calls where the TODO markers are.
//
// TODO: npm install stripe
// TODO: import Stripe from "stripe" and create:
//   const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "..." })

export interface CheckoutInput {
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSessionStub {
  id: string;
  url: string;
}

/**
 * Build the parameters the checkout session creation call will need.
 * Returns null while STRIPE_PRICE_ID is unset so callers can fail clean
 * instead of sending partial requests.
 */
export function buildCheckoutParams(input: CheckoutInput): CheckoutSessionStub | null {
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) return null;

  // Real implementation sketch (behind TODO above):
  //   return stripe.checkout.sessions.create({
  //     mode: "payment",
  //     line_items: [{ price: priceId, quantity: 1 }],
  //     success_url: input.successUrl,
  //     cancel_url: input.cancelUrl,
  //   });
  return {
    id: "stub_checkout_session",
    url: input.successUrl,
  };
}

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
}
`;

function envExample(names: string[]): string {
  const lines = names.map((n) => `${n}=`);
  return ["# Starter environment variables.", "# Replace '=' values locally with real credentials; NEVER commit them.", ...lines, ""].join("\n");
}

function filesFor(kind: ScaffoldKind): ScaffoldFile[] {
  switch (kind) {
    case "supabase":
      return [
        { relPath: "supabase/migrations/0001_init.sql", content: SUPABASE_MIGRATION },
        { relPath: "src/lib/supabaseClient.ts", content: SUPABASE_CLIENT },
        { relPath: ".env.example", content: envExample(["SUPABASE_URL", "SUPABASE_ANON_KEY"]) },
      ];
    case "db":
      return [
        { relPath: "migrations/0001_init.sql", content: DB_MIGRATION },
        { relPath: "src/lib/db.ts", content: DB_CLIENT },
        { relPath: ".env.example", content: envExample(["DATABASE_URL"]) },
      ];
    case "stripe":
      return [
        { relPath: "src/lib/stripeCheckout.ts", content: STRIPE_CHECKOUT },
        { relPath: ".env.example", content: envExample(["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID"]) },
      ];
  }
}

/** Resolve projectDir as a direct relative sub-path of the workspace; never escape it. */
export function resolveScaffoldDir(workspace: string, projectDir: string): string {
  const normalized = projectDir.trim().replaceAll("\\", "/");
  if (normalized !== "" && path.isAbsolute(normalized)) {
    throw new Error("projectDir must be a relative path inside the workspace");
  }
  if (normalized.includes("..") || normalized.startsWith("/")) {
    throw new Error("projectDir must not contain '..' or drive/UNC references");
  }
  const resolved = path.resolve(workspace, normalized);
  if (resolved !== workspace && !resolved.startsWith(workspace + path.sep)) {
    throw new Error("projectDir must resolve inside the workspace");
  }
  return resolved;
}

export function scaffoldBackend(kind: ScaffoldKind, dir: string): { ok: boolean; content: string } {
  const files = filesFor(kind);
  const written: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const abs = path.join(dir, file.relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (fs.existsSync(abs)) {
      skipped.push(file.relPath);
      continue;
    }
    fs.writeFileSync(abs, file.content, "utf8");
    written.push(file.relPath);
  }
  const parts = [`scaffold_backend (${kind}) in ${dir}`];
  if (written.length > 0) parts.push(`created: ${written.join(", ")}`);
  if (skipped.length > 0) parts.push(`skipped existing: ${skipped.join(", ")}`);
  return { ok: true, content: parts.join(" | ") };
}

export function createBackendScaffoldTools(): Tool[] {
  return [
    {
      name: "scaffold_backend",
      description:
        "Offline backend scaffold generator. kind=supabase writes supabase/migrations SQL, a Supabase client init and an empty-value .env.example; kind=db writes vendor-agnostic migrations plus a DB client init; kind=stripe writes a checkout stub and .env.example. Placeholder variable names only; never writes real keys and makes no network calls.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...KINDS], description: "Scaffold kind: supabase, db or stripe" },
          projectDir: {
            type: "string",
            description: "Relative subdirectory of the workspace to scaffold into (default: workspace root)",
          },
        },
        required: ["kind"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const kindArg = str(args, "kind");
        if (!(KINDS as readonly string[]).includes(kindArg)) {
          return { ok: false, content: `scaffold_backend: kind must be one of ${KINDS.join(", ")}` };
        }
        const projectDir = str(args, "projectDir", ".");
        let dir: string;
        try {
          dir = resolveScaffoldDir(ctx.workspace, projectDir);
        } catch (err) {
          return { ok: false, content: `scaffold_backend refused: ${err instanceof Error ? err.message : String(err)}` };
        }
        try {
          return scaffoldBackend(kindArg as ScaffoldKind, dir);
        } catch (err) {
          return { ok: false, content: `scaffold_backend failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
  ];
}
