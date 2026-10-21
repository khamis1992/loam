/**
 * Tests for scaffold_backend (Supabase/DB/Stripe starter-file generator).
 *
 * Guarantees under test:
 *  - expected starter files are created with placeholder-only .env.example
 *  - no real-looking secret material ever appears in generated content
 *  - generated code performs no network I/O
 *  - writes stay inside the task workspace and never overwrite existing files
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

import { createBackendScaffoldTools, resolveScaffoldDir } from "../backendScaffold.js";

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

describe("scaffold_backend", () => {
  let tools = createBackendScaffoldTools();
  const tool = () => tools.find((t) => t.name === "scaffold_backend")!;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-scaffold-"));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("supabase: writes schema, client init and placeholder .env.example", async () => {
    const res = await tool().run({ kind: "supabase" }, { cfg: {} as never, workspace: tmpDir, emit: () => {} });
    assert.equal(res.ok, true);
    const files = readDirFiles(tmpDir);
    const byName = new Map(files.map((f) => [f.rel.replaceAll("\\", "/"), f]));
    const migration = byName.get("supabase/migrations/0001_init.sql");
    assert.ok(migration, "migration exists");
    assert.match(migration.content, /create table if not exists items/);
    const client = byName.get("src/lib/supabaseClient.ts");
    assert.ok(client, "client init exists");
    assert.match(client.content, /process\.env\.SUPABASE_URL/);
    const env = byName.get(".env.example");
    assert.ok(env, ".env.example exists");
    assert.match(env.content, /^SUPABASE_URL=/m);
    assert.match(env.content, /^SUPABASE_ANON_KEY=/m);
  });

  it("db: writes vendor-agnostic migrations and client init", async () => {
    const res = await tool().run({ kind: "db" }, { cfg: {} as never, workspace: tmpDir, emit: () => {} });
    assert.equal(res.ok, true);
    const env = fs.readFileSync(path.join(tmpDir, ".env.example"), "utf8");
    assert.match(env, /^DATABASE_URL=/m);
    assert.ok(fs.existsSync(path.join(tmpDir, "migrations", "0001_init.sql")));
    assert.ok(fs.existsSync(path.join(tmpDir, "src", "lib", "db.ts")));
  });

  it("stripe: writes checkout stub and placeholder .env.example", async () => {
    const res = await tool().run({ kind: "stripe" }, { cfg: {} as never, workspace: tmpDir, emit: () => {} });
    assert.equal(res.ok, true);
    const stub = fs.readFileSync(path.join(tmpDir, "src", "lib", "stripeCheckout.ts"), "utf8");
    assert.match(stub, /process\.env\.STRIPE_SECRET_KEY/);
    assert.match(stub, /STRIPE_PRICE_ID/);
    const env = fs.readFileSync(path.join(tmpDir, ".env.example"), "utf8");
    assert.match(env, /^STRIPE_SECRET_KEY=/m);
    assert.match(env, /^STRIPE_PRICE_ID=/m);
  });

  it("all generated files are free of secret-looking values", async () => {
    for (const kind of ["supabase", "db", "stripe"] as const) {
      await tool().run({ kind, projectDir: kind }, { cfg: {} as never, workspace: tmpDir, emit: () => {} });
      for (const file of readDirFiles(path.join(tmpDir, kind))) {
        for (const pattern of SECRET_PATTERNS) {
          assert.ok(!pattern.test(file.content), `${kind}/${file.rel} must not contain secret-shaped data`);
        }
        // .env.example values stay empty: name followed by '=' and nothing.
        if (file.rel.includes(".env.example")) {
          for (const line of file.content.split("\n")) {
            if (line && !line.startsWith("#")) assert.match(line, /^[A-Z0-9_]+=$/, `empty value in ${file.rel}: ${line}`);
          }
        }
      }
    }
  });

  it("generated code performs no network I/O", async () => {
    for (const kind of ["supabase", "db", "stripe"] as const) {
      await tool().run({ kind }, { cfg: {} as never, workspace: tmpDir, emit: () => {} });
    }
    const codeFiles = readDirFiles(tmpDir).filter((f) => f.rel.endsWith(".ts"));
    assert.ok(codeFiles.length >= 3, "client/stub files exist");
    for (const file of codeFiles) {
      assert.ok(!/fetch\(|axios|https?:\/\//.test(file.content), `${file.rel} must make no network calls`);
    }
  });

  it("projectDir may not escape the workspace", async () => {
    for (const bad of ["../escape", "..\\escape", "/abs", "C:\\evil", "a/../../b"]) {
      const res = await tool().run({ kind: "db", projectDir: bad }, { cfg: {} as never, workspace: tmpDir, emit: () => {} });
      assert.equal(res.ok, false, `expected refusal for ${bad}`);
      assert.match(res.content, /refused/);
    }
    assert.deepEqual(fs.readdirSync(tmpDir), [], "nothing was written outside the workspace");
  });

  it("never overwrites existing files", async () => {
    const marker = path.join(tmpDir, ".env.example");
    fs.writeFileSync(marker, "LOCAL_MARKER=1\n", "utf8");
    await tool().run({ kind: "stripe" }, { cfg: {} as never, workspace: tmpDir, emit: () => {} });
    assert.equal(fs.readFileSync(marker, "utf8"), "LOCAL_MARKER=1\n");
  });

  it("resolveScaffoldDir confines paths", () => {
    assert.equal(resolveScaffoldDir(tmpDir, "app"), path.resolve(tmpDir, "app"));
    assert.equal(resolveScaffoldDir(tmpDir, "."), path.resolve(tmpDir));
    assert.throws(() => resolveScaffoldDir(tmpDir, "../x"));
    assert.throws(() => resolveScaffoldDir(tmpDir, "C:/x"));
  });
});
