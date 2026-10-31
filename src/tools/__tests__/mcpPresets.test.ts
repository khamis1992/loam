import assert from "node:assert/strict";
import test from "node:test";
import type { McpServerConfig } from "../../config.js";
import { applyMcpPresets, expandEnvHeaders, MCP_PRESETS } from "../mcpPresets.js";

/** Run fn with env vars set, restoring everything afterwards. */
async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("presets: curated registry is well-formed", () => {
  const ids = Object.keys(MCP_PRESETS);
  assert.deepEqual(ids.sort(), ["google-drive", "google-mail", "supabase", "vercel"]);
  for (const preset of Object.values(MCP_PRESETS)) {
    assert.ok(preset.url.startsWith("https://"), `${preset.id} uses https`);
    assert.ok(preset.label.length > 0 && preset.setupAr.length > 0, `${preset.id} has Arabic labels`);
    assert.equal(preset.lazy, true, `${preset.id} stays out of the prompt`);
    for (const envVar of preset.requiredEnv) {
      assert.ok(JSON.stringify(preset.headers).includes(`\${ENV:${envVar}}`), `${preset.id} header references ${envVar}`);
    }
  }
});

test("applyMcpPresets: overlays defaults, user fields win, result is preset-free", () => {
  const servers: Record<string, McpServerConfig> = {
    supabase: { preset: "supabase" },
    "my-own": { command: "node", args: ["server.js"] },
    mirrored: { preset: "vercel", url: "https://internal-vcs.corp/mcp", allowlist: ["deploy"] },
  };
  const resolved = applyMcpPresets(servers);
  const supabase = resolved.supabase;
  const mirrored = resolved.mirrored;
  assert.ok(supabase && mirrored, "preset entries resolved");
  assert.equal(supabase.transport, "http");
  assert.equal(supabase.url, MCP_PRESETS.supabase!.url);
  assert.deepEqual(supabase.headers, { authorization: "Bearer ${ENV:LOAM_SUPABASE_PAT}" });
  assert.equal(supabase.lazy, true);
  assert.equal("preset" in supabase, false, "preset field stripped");
  // user override beats the preset; untouched extras pass through
  assert.equal(mirrored.url, "https://internal-vcs.corp/mcp");
  assert.deepEqual(mirrored.allowlist, ["deploy"]);
  assert.deepEqual(mirrored.headers, { authorization: "Bearer ${ENV:VERCEL_MCP_TOKEN}" });
  // non-preset entries pass through untouched
  assert.deepEqual(resolved["my-own"], { command: "node", args: ["server.js"] });
});

test("applyMcpPresets: unknown presets are dropped, never a crash", () => {
  const resolved = applyMcpPresets({ ghost: { preset: "does-not-exist" }, keep: { preset: "supabase" } });
  assert.equal("ghost" in resolved, false);
  const keep = resolved.keep;
  assert.ok(keep, "valid preset kept");
  assert.equal(keep.transport, "http");
});

test("expandEnvHeaders: resolves tokens, throws naming the var (never a value)", async () => {
  await withEnv({ LOAM_SUPABASE_PAT: "sbp_secret_token", VERCEL_MCP_TOKEN: undefined }, () => {
    const resolved = expandEnvHeaders({ authorization: "Bearer ${ENV:LOAM_SUPABASE_PAT}", "x-plain": "static" });
    assert.deepEqual(resolved, { authorization: "Bearer sbp_secret_token", "x-plain": "static" });
    assert.throws(
      () => expandEnvHeaders({ authorization: "Bearer ${ENV:VERCEL_MCP_TOKEN}" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /VERCEL_MCP_TOKEN/);
        // the thrown message must never carry neighboring header values
        assert.ok(!err.message.includes("sbp_secret_token"));
        return true;
      },
    );
  });
});

test("expandEnvHeaders: empty and multi-token headers", async () => {
  await withEnv({ A_MCP_KEY: "aaa", B_MCP_KEY: "bbb" }, () => {
    assert.deepEqual(expandEnvHeaders(undefined), {});
    assert.deepEqual(
      expandEnvHeaders({ "x-combo": "${ENV:A_MCP_KEY}:${ENV:B_MCP_KEY}" }),
      { "x-combo": "aaa:bbb" },
    );
  });
});
