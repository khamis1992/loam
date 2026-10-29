// W4b tests — the EAS BYOK wrapper (scripts/eas-build.mjs). The spawn seam is
// injected, so the real eas CLI is never invoked here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const easUrl = new URL("../../../scripts/eas-build.mjs", import.meta.url).href;
const eas = (await import(easUrl)) as {
  parseEasArgs: (argv: string[]) => { ok: true; value: Record<string, unknown> } | { ok: false; error: string };
  resolveProjectDir: (explicit: string | null, cwd?: string) => { ok: true; value: string } | { ok: false; error: string };
  runEasBuild: (opts: Record<string, unknown>, deps?: { run?: unknown; cwd?: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
};

type Call = { cmd: string; args: string[] };

/** Mock spawn seam: records every call, answers per subcommand. */
function mockRun(answers: { version?: number; whoami?: number; build?: number; submit?: number }) {
  const calls: Call[] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const sub = args[0];
    if (sub === "--version") return { code: answers.version ?? 0, stdout: "eas-cli/13.0.0", stderr: "" };
    if (sub === "whoami") return { code: answers.whoami ?? 0, stdout: "user@example.com", stderr: "" };
    if (sub === "build") return { code: answers.build ?? 0, stdout: "", stderr: "" };
    if (sub === "submit") return { code: answers.submit ?? 0, stdout: "", stderr: "" };
    return { code: -1, stdout: "", stderr: "" };
  };
  return { calls, run };
}

function expoDir(): { root: string; dir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-eas-"));
  const dir = path.join(root, "expo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "app.json"), "{\n  \"expo\": { \"name\": \"t\", \"slug\": \"t\" }\n}\n", "utf8");
  return { root, dir };
}

// ---------- arg validation (Arabic, honest) ----------

test("eas: platform is required and must be android or ios", () => {
  const none = eas.parseEasArgs([]);
  assert.equal(none.ok, false);
  assert.ok(none.ok === false && /android أو ios/.test(none.error), "Arabic usage error");
  const bad = eas.parseEasArgs(["--platform", "web"]);
  assert.ok(bad.ok === false && /android أو ios/.test(bad.error));
});

test("eas: unknown flags, missing values and bad profiles are rejected", () => {
  assert.equal(eas.parseEasArgs(["--platform", "android", "--bogus"]).ok, false);
  assert.equal(eas.parseEasArgs(["--platform", "android", "--profile"]).ok, false);
  const badProfile = eas.parseEasArgs(["--platform", "android", "--profile", "bad profile!"]);
  assert.ok(badProfile.ok === false, "bad profile charset refused");
  assert.ok(/ملف التعريف/.test(badProfile.error), "the refusal is the honest Arabic profile error");
});

test("eas: --local is android-only", () => {
  const r = eas.parseEasArgs(["--platform", "ios", "--local"]);
  assert.ok(r.ok === false && /--local/.test(r.error) && /أندرويد/.test(r.error), "honest Arabic error for ios --local");
  const okLocal = eas.parseEasArgs(["--platform", "android", "--local", "--submit", "--profile", "production"]);
  assert.ok(okLocal.ok);
  assert.equal(okLocal.value.platform, "android");
  assert.equal(okLocal.value.profile, "production");
  assert.equal(okLocal.value.submit, true);
  assert.equal(okLocal.value.local, true);
});

// ---------- project dir resolution ----------

test("eas: default projectDir prefers ./expo; refuses non-Expo folders honestly", () => {
  const { root, dir } = expoDir();
  const def = eas.resolveProjectDir(null, root);
  assert.ok(def.ok && def.value === dir, "./expo is the default when present");
  const explicit = eas.resolveProjectDir("expo", root);
  assert.ok(explicit.ok);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "loam-eas-empty-"));
  const bad = eas.resolveProjectDir(null, empty);
  assert.ok(bad.ok === false && /مشروع Expo/.test(bad.error), "Arabic not-an-Expo-project error");
  const missing = eas.resolveProjectDir("nope", root);
  assert.ok(missing.ok === false && /غير موجود/.test(missing.error));
});

// ---------- the BYOK flow through the injected spawn seam ----------

test("eas: missing CLI → honest Arabic error, eas build never invoked", async () => {
  const { root } = expoDir();
  const { calls, run } = mockRun({ version: -1 });
  const r = await eas.runEasBuild({ platform: "android" }, { run, cwd: root });
  assert.ok(r.ok === false && /غير مثبتة/.test(r.error) && /eas-cli/.test(r.error));
  assert.ok(calls.every((c) => c.args[0] !== "build" && c.args[0] !== "submit"), "never invoked a real build");
});

test("eas: not logged in → honest Arabic error before any build", async () => {
  const { root } = expoDir();
  const { calls, run } = mockRun({ whoami: 1 });
  const r = await eas.runEasBuild({ platform: "ios" }, { run, cwd: root });
  assert.ok(r.ok === false && /غير مسجّل/.test(r.error) && /eas login/.test(r.error));
  assert.ok(calls.every((c) => c.args[0] !== "build"));
});

test("eas: invalid project dir → Arabic error, CLI never called", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "loam-eas-empty2-"));
  const { calls, run } = mockRun({});
  const r = await eas.runEasBuild({ platform: "android" }, { run, cwd: empty });
  assert.ok(r.ok === false && /مشروع Expo/.test(r.error));
  assert.equal(calls.length, 0);
});

test("eas: android build runs non-interactive; --local and --profile pass through; submit only when asked", async () => {
  const { root } = expoDir();
  const noSubmit = mockRun({});
  const r1 = await eas.runEasBuild({ platform: "android" }, { run: noSubmit.run, cwd: root });
  assert.deepEqual(r1, { ok: true });
  const build1 = noSubmit.calls.find((c) => c.args[0] === "build")!;
  assert.deepEqual(build1.args, ["build", "--platform", "android", "--non-interactive"]);
  assert.ok(!noSubmit.calls.some((c) => c.args[0] === "submit"));

  const full = mockRun({});
  const r2 = await eas.runEasBuild({ platform: "android", profile: "preview", local: true, submit: true }, { run: full.run, cwd: root });
  assert.deepEqual(r2, { ok: true });
  const build2 = full.calls.find((c) => c.args[0] === "build")!;
  assert.deepEqual(build2.args, ["build", "--platform", "android", "--non-interactive", "--profile", "preview", "--local"]);
  const submit = full.calls.find((c) => c.args[0] === "submit")!;
  assert.deepEqual(submit.args, ["submit", "--platform", "android", "--latest", "--non-interactive", "--profile", "preview"]);
});

test("eas: ios cloud build (no --local) and honest Arabic failure with the exit code", async () => {
  const { root } = expoDir();
  const ok = mockRun({});
  await eas.runEasBuild({ platform: "ios", submit: true }, { run: ok.run, cwd: root });
  const build = ok.calls.find((c) => c.args[0] === "build")!;
  assert.ok(!build.args.includes("--local"), "ios never gets --local");
  assert.ok(build.args.includes("ios"));

  const fail = mockRun({ build: 3 });
  const r = await eas.runEasBuild({ platform: "ios" }, { run: fail.run, cwd: root });
  assert.ok(r.ok === false && /فشل بناء EAS/.test(r.error) && r.error.includes("3"), "exit code surfaces in the Arabic error");
  assert.ok(fail.calls.every((c) => c.args[0] !== "submit"), "no submit after a failed build");

  const failSubmit = mockRun({ submit: 2 });
  const r2 = await eas.runEasBuild({ platform: "android", submit: true }, { run: failSubmit.run, cwd: root });
  assert.ok(r2.ok === false && /فشل إرسال/.test(r2.error) && r2.error.includes("2"));
});
