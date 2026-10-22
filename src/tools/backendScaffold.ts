/**
 * scaffold_backend: offline starter-file generator for backend scaffolds.
 *
 * Kinds:
 *  - "supabase": SQL migrations + schema, RLS policies, seed, updated_at
 *    triggers, Supabase client init, setup README, .env.example
 *  - "db": vendor-agnostic SQL migrations + DB client init, .env.example
 *  - "stripe": checkout stub, plan catalog, webhook skeleton, guided setup
 *    script, setup README, .env.example
 *
 * Template payloads live in src/tools/templates/backend/ as bundled TypeScript
 * string modules (bundled by esbuild; no runtime file loading).
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

import {
  SUPABASE_CLIENT,
  SUPABASE_MIGRATION,
  SUPABASE_RLS_POLICY,
  SUPABASE_README,
  SUPABASE_SEED,
  SUPABASE_TRIGGER_MIGRATION,
} from "./templates/backend/supabaseTemplates.js";
import { STRIPE_CHECKOUT, STRIPE_PLANS, STRIPE_README, STRIPE_SETUP_SCRIPT, STRIPE_WEBHOOK } from "./templates/backend/stripeTemplates.js";
import { DB_CLIENT, DB_MIGRATION } from "./templates/backend/dbTemplates.js";

type ScaffoldKind = "supabase" | "db" | "stripe";
const KINDS: readonly ScaffoldKind[] = ["supabase", "db", "stripe"];

interface ScaffoldFile {
  relPath: string;
  content: string;
}

function envExample(names: string[]): string {
  const lines = names.map((n) => `${n}=`);
  return ["# Starter environment variables.", "# Replace '=' values locally with real credentials; NEVER commit them.", ...lines, ""].join("\n");
}

/** Complete file list per kind. Never overwrites; callers merge into a project. */
export function filesFor(kind: ScaffoldKind): ScaffoldFile[] {
  switch (kind) {
    case "supabase":
      return [
        { relPath: "supabase/migrations/0001_init.sql", content: SUPABASE_MIGRATION },
        { relPath: "supabase/migrations/0002_triggers.sql", content: SUPABASE_TRIGGER_MIGRATION },
        { relPath: "supabase/policies.sql", content: SUPABASE_RLS_POLICY },
        { relPath: "supabase/seed.sql", content: SUPABASE_SEED },
        { relPath: "src/lib/supabaseClient.ts", content: SUPABASE_CLIENT },
        { relPath: "supabase/README.md", content: SUPABASE_README },
        {
          relPath: ".env.example",
          content: envExample(["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]),
        },
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
        { relPath: "src/lib/stripePlans.ts", content: STRIPE_PLANS },
        { relPath: "src/lib/stripeWebhook.ts", content: STRIPE_WEBHOOK },
        { relPath: "scripts/stripeSetup.ts", content: STRIPE_SETUP_SCRIPT },
        { relPath: "docs/stripe-setup.md", content: STRIPE_README },
        {
          relPath: ".env.example",
          content: envExample([
            "STRIPE_SECRET_KEY",
            "STRIPE_PUBLISHABLE_KEY",
            "STRIPE_WEBHOOK_SECRET",
            "STRIPE_PRICE_ID",
            "STRIPE_PRICE_ID_PRO",
            "STRIPE_PRICE_ID_BASIC",
          ]),
        },
      ];
  }
}

/** Resolve projectDir as a direct relative sub-path of the workspace; never escape it. */
export function resolveScaffoldDir(workspace: string, projectDir: string): string {
  const normalized = projectDir.trim().replaceAll("\\", "/");
  if (normalized !== "" && path.isAbsolute(normalized)) {
    throw new Error("projectDir must be a relative path inside the workspace");
  }
  const segments = normalized.split("/");
  if (normalized.startsWith("/") || segments.some((part) => part === "..")) {
    throw new Error("projectDir must not contain '..' or drive/UNC references");
  }
  const resolved = path.resolve(workspace, normalized);
  if (resolved !== workspace && !resolved.startsWith(workspace + path.sep)) {
    throw new Error("projectDir must resolve inside the workspace");
  }
  assertNoSymlinkEscape(workspace, resolved);
  return resolved;
}

/**
 * Lexical path checks cannot see a symlink that points outside the workspace.
 * Realpath the deepest existing ancestor of the target and require it to stay
 * under the real workspace root, so `projectDir` cannot smuggle writes out.
 */
function assertNoSymlinkEscape(workspace: string, resolved: string): void {
  if (!fs.existsSync(workspace)) return; // nothing exists yet: no escape is possible
  const realWorkspace = fs.realpathSync(workspace);
  let anchor = resolved;
  while (!fs.existsSync(anchor)) {
    const parent = path.dirname(anchor);
    if (parent === anchor) break;
    anchor = parent;
  }
  const realAnchor = fs.realpathSync(anchor);
  if (realAnchor !== realWorkspace && !realAnchor.startsWith(realWorkspace + path.sep)) {
    throw new Error("projectDir resolves outside the workspace (symlink escape)");
  }
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
        "Offline backend scaffold generator. kind=supabase writes supabase/migrations SQL (schema + updated_at triggers), a row-level-security policy stub, idempotent seed SQL, a Supabase client init and an empty-value .env.example; kind=db writes vendor-agnostic migrations plus a DB client init; kind=stripe writes checkout, plan-catalog and webhook stubs plus a guided scripts/stripeSetup.ts skeleton and .env.example. Placeholder variable names only; never writes real keys and makes no network calls.",
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
