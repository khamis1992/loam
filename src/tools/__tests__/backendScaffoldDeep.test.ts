/**
 * Focused tests for the ft7 deepen pass on scaffold_backend:
 * full Supabase output (schema/migrations/RLS/seed) and full Stripe setup
 * (checkout/plans/webhook/setup script), plus the safety invariants that must
 * hold for every newly generated file.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

import { createBackendScaffoldTools, filesFor } from "../backendScaffold.js";

let tmpDir = "";

/** Patterns that look like real credentials/tokens if they ever leaked. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk_live_[A-Za-z0-9]{10,}/,
  /sk_test_[A-Za-z0-9]{10,}/,
  /pk_live_[A-Za-z0-9]{10,}/,
  /whsec_[A-Za-z0-9]{10,}/,
  /eyJ[A-Za-z0-9_-]{20,}/, // JWT-shaped tokens
  /^[A-Za-z0-9+/=]{40,}$/m, // long opaque base64 blobs alone on a line
];

function readDirFiles(dir: string): { rel: string; abs: string; content: string }[] {
  const out: { rel: string; abs: string; content: string }[] = [];
  const walk = (cur: string, prefix: string) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, entry.name);
      const rel = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else out.push({ rel, abs, content: fs.readFileSync(abs, "utf8") });
    }
  };
  walk(dir, "");
  return out;
}

const shell = () => ({ cfg: {} as never, workspace: tmpDir, emit: () => {} });

describe("scaffold_backend deepening (ft7)", () => {
  let tools = createBackendScaffoldTools();
  const tool = () => tools.find((t) => t.name === "scaffold_backend")!;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-scaffold-deep-"));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("supabase: emits schema, trigger migration, RLS policies, seed and README", async () => {
    const res = await tool().run({ kind: "supabase" }, shell());
    assert.equal(res.ok, true);
    const read = (rel: string) => fs.readFileSync(path.join(tmpDir, ...rel.split("/")), "utf8");
    const migration = read("supabase/migrations/0001_init.sql");
    assert.match(migration, /create table if not exists app_users/);
    assert.match(migration, /create table if not exists items/);
    assert.match(migration, /create index if not exists items_owner_id_idx/);

    const triggers = read("supabase/migrations/0002_triggers.sql");
    assert.match(triggers, /CREATE OR REPLACE FUNCTION set_public_updated_at/);
    assert.match(triggers, /CREATE TRIGGER items_updated_at/);

    const policies = read("supabase/policies.sql");
    assert.match(policies, /alter table items enable row level security/);
    assert.match(policies, /alter table app_users enable row level security/);
    // owner-scoped policy skeletons exist for each table
    assert.match(policies, /create policy "items select own"/);
    assert.match(policies, /create policy "app_users select own"/);
    assert.match(policies, /auth\.uid\(\)/);

    const seed = read("supabase/seed.sql");
    assert.match(seed, /insert into app_users/);
    assert.match(seed, /where not exists/, "seed must be idempotent");

    const readme = read("supabase/README.md");
    assert.match(readme, /supabase db push/);
    assert.match(readme, /RLS checklist/);
  });

  it("supabase: client init reads env; service-role key stays placeholder-only", async () => {
    await tool().run({ kind: "supabase" }, shell());
    const read = (rel: string) => fs.readFileSync(path.join(tmpDir, ...rel.split("/")), "utf8");
    const client = read("src/lib/supabaseClient.ts");
    assert.match(client, /process\.env\.SUPABASE_URL/);
    assert.match(client, /process\.env\.SUPABASE_ANON_KEY/);
    assert.match(client, /getServiceRoleKeyOrNull/);
    const env = read(".env.example");
    for (const name of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
      assert.match(env, new RegExp(`^${name}=$`, "m"), `${name} value must stay empty`);
    }
  });

  it("stripe: emits checkout, plans, webhook skeleton, setup script and setup README", async () => {
    const res = await tool().run({ kind: "stripe" }, shell());
    assert.equal(res.ok, true);
    const read = (rel: string) => fs.readFileSync(path.join(tmpDir, ...rel.split("/")), "utf8");

    assert.ok(read("src/lib/stripeCheckout.ts").includes("buildCheckoutParams"));

    const plans = read("src/lib/stripePlans.ts");
    assert.match(plans, /priceIdForPlan/);
    assert.match(plans, /STRIPE_PRICE_ID_PRO/);
    assert.match(plans, /STRIPE_PRICE_ID_BASIC/);

    const webhook = read("src/lib/stripeWebhook.ts");
    assert.match(webhook, /process\.env\.STRIPE_WEBHOOK_SECRET/);
    assert.match(webhook, /return null/, "webhook stub must fail clean without a secret");
    assert.match(webhook, /constructEvent/, "TODO points at real signature verification");

    const setup = read("scripts/stripeSetup.ts");
    assert.match(setup, /buildSetupChecklist/);
    assert.match(setup, /no API calls/);

    const readme = read("docs/stripe-setup.md");
    assert.match(readme, /STRIPE_WEBHOOK_SECRET/);
    assert.match(readme, /RAW request body/);

    const env = read(".env.example");
    for (const name of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID", "STRIPE_PRICE_ID_PRO", "STRIPE_PRICE_ID_BASIC"]) {
      assert.match(env, new RegExp(`^${name}=$`, "m"), `${name} value must stay empty`);
    }
  });

  it("every generated file stays free of secret-shaped material and network I/O", async () => {
    for (const kind of ["supabase", "stripe"] as const) {
      await tool().run({ kind }, shell());
    }
    const files = readDirFiles(tmpDir);
    assert.ok(files.some((f) => f.rel.endsWith("policies.sql")), "RLS file present");
    assert.ok(files.some((f) => f.rel.endsWith("stripeWebhook.ts")), "webhook present");
    for (const file of files) {
      for (const pattern of SECRET_PATTERNS) {
        assert.ok(!pattern.test(file.content), `${file.rel} must not contain secret-shaped data`);
      }
      if (file.rel.endsWith(".ts")) {
        assert.ok(!/fetch\(|axios|https?:\/\//.test(file.content), `${file.rel} must make no network calls`);
      }
      if (file.rel.includes(".env.example")) {
        for (const line of file.content.split("\n")) {
          if (line && !line.startsWith("#")) assert.match(line, /^[A-Z0-9_]+=$/, `empty value in ${file.rel}: ${line}`);
        }
      }
    }
  });

  it("deep files honor no-overwrite: pre-existing RLS/seed/webhook files are untouched", async () => {
    for (const rel of ["supabase/policies.sql", "supabase/seed.sql", "src/lib/stripeWebhook.ts", "scripts/stripeSetup.ts"]) {
      const abs = path.join(tmpDir, ...rel.split("/"));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `LOCAL_MARKER ${rel}\n`, "utf8");
    }
    const res = await tool().run({ kind: "supabase" }, shell());
    assert.equal(res.ok, true);
    const res2 = await tool().run({ kind: "stripe" }, shell());
    assert.equal(res2.ok, true);
    for (const rel of ["supabase/policies.sql", "supabase/seed.sql", "src/lib/stripeWebhook.ts", "scripts/stripeSetup.ts"]) {
      const abs = path.join(tmpDir, ...rel.split("/"));
      assert.match(fs.readFileSync(abs, "utf8"), /LOCAL_MARKER/, `${rel} must not be overwritten`);
    }
    // the summary reports the skips explicitly
    assert.match(res.content, /skipped existing/);
    assert.match(res2.content, /skipped existing/);
  });

  it("filesFor lists the complete expected set per deepened kind", () => {
    const supabasePaths = filesFor("supabase").map((f) => f.relPath);
    assert.deepEqual(supabasePaths, [
      "supabase/migrations/0001_init.sql",
      "supabase/migrations/0002_triggers.sql",
      "supabase/policies.sql",
      "supabase/seed.sql",
      "src/lib/supabaseClient.ts",
      "supabase/README.md",
      ".env.example",
    ]);
    const stripePaths = filesFor("stripe").map((f) => f.relPath);
    assert.deepEqual(stripePaths, [
      "src/lib/stripeCheckout.ts",
      "src/lib/stripePlans.ts",
      "src/lib/stripeWebhook.ts",
      "scripts/stripeSetup.ts",
      "docs/stripe-setup.md",
      ".env.example",
    ]);
  });
});
