import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkDesignDoc, designDocSkeleton } from "../designDoc.js";
import { redactSecrets } from "../redact.js";
import { parseBridgeLine, recordRuntimeError, listRuntimeErrors, clearRuntimeErrors, fixPromptFor, BRIDGE_PREFIX } from "../runtimeErrors.js";
import { THEMES, applyTheme } from "../themes.js";

test("checkDesignDoc rejects missing headings and oversize; accepts a filled skeleton", () => {
  const bad = checkDesignDoc("# x\n\n## Tokens\n- none");
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => p.includes("missing heading")));
  const over = checkDesignDoc(["## Direction & Layout", "## Tokens", "## Patterns & States", "## Media", "x".repeat(7_000)].join("\n"));
  assert.ok(over.problems.some((p) => p.includes("over")));
  const good = checkDesignDoc(designDocSkeleton("متجر").replace("oklch(0.55 0.15 260)", "oklch(0.55 0.15 260) 400px"));
  assert.equal(good.ok, true, good.problems.join(";"));
});

test("redactSecrets replaces every pattern and keeps plain text", () => {
  const dirty = "sk-abcdefghijklmnopqrst key xai-12345678901234567890 ghp_" + "a".repeat(34) + " eyJaaaaaaaaaaaaaa.bbbbbbbbbbbbbb.cccccccccccc Authorization: Bearer abc123 api_key=\"supersecret1\"";
  const out = redactSecrets(dirty);
  assert.ok(!out.includes("sk-abcdefghijklmnopqrst"));
  assert.ok(!out.includes("xai-12345678901234567890"));
  assert.ok(!out.includes("ghp_"));
  assert.ok(!out.includes("Bearer abc123"));
  assert.ok(!out.includes("supersecret1"));
  assert.equal(redactSecrets("plain text يبقى كما هو 123"), "plain text يبقى كما هو 123");
});

test("runtime errors: bridge parse, dedup count, fix prompt", () => {
  const line = BRIDGE_PREFIX + JSON.stringify({ kind: "console.error", message: "boom", stack: null, source: { file: "src/App.tsx", line: 3, column: 5 }, url: "/" });
  const e = parseBridgeLine(line)!;
  assert.equal(e.message, "boom");
  assert.equal(parseBridgeLine("vite ready"), null);
  const first = recordRuntimeError("app_x", e);
  assert.ok(first, "first occurrence returns the record");
  assert.equal(recordRuntimeError("app_x", e), undefined, "dedup returns nothing");
  assert.equal(listRuntimeErrors("app_x")[0]!.count, 2);
  assert.match(fixPromptFor(listRuntimeErrors("app_x")[0]!), /@Engineer Web page running error/);
  clearRuntimeErrors("app_x");
  assert.equal(listRuntimeErrors("app_x").length, 0);
});

test("themes: idempotent apply + neutral restore", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-th-"));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  const css = path.join(tmp, "src", "index.css");
  fs.writeFileSync(css, ":root {\n  --background: oklch(1 0 0);\n  --foreground: oklch(0.1 0 0);\n}\n\n/* loam:theme:start */\n/* loam:theme:end */\n");
  applyTheme(tmp, "ocean");
  const once = fs.readFileSync(css, "utf8");
  applyTheme(tmp, "ocean");
  const twice = fs.readFileSync(css, "utf8");
  assert.equal((once.match(/loam:theme:start/g) ?? []).length, (twice.match(/loam:theme:start/g) ?? []).length, "applying twice keeps one block");
  applyTheme(tmp, "neutral");
  assert.ok(!fs.readFileSync(css, "utf8").includes("--primary"), "neutral removes the block");
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.ok(THEMES.length >= 4);
});
