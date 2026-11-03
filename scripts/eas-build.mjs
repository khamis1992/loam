#!/usr/bin/env node
// scripts/eas-build.mjs — W4b: EAS store builds for generated mobile apps (BYOK).
//
// Wraps the Expo Application Services CLI around an Expo project (the expo/
// folder of a Loam mobile export, or any --projectDir). BYOK end to end:
//   - the user installs the eas CLI themselves (npm install -g eas-cli)
//   - the user logs in with their own Expo account (eas login)
//   - builds run on Expo's cloud (or --local for android) under that account
//   - Loam stores NO keys, NO tokens, NO credentials — nothing about the
//     account ever passes through this script
// Generated mobile apps ship an Expo layout in the export ZIP's expo/ folder
// (Expo SDK 53, app.json + package.json — see src/mobile/export.ts), so the
// default projectDir is ./expo when it exists.
//
// Usage:
//   npm run eas:build -- --platform android
//   npm run eas:build -- --platform android --local          # local build (needs Android SDK)
//   npm run eas:build -- --platform ios --profile production
//   npm run eas:build -- --platform android --submit          # build then eas submit --latest
//   node scripts/eas-build.mjs --platform ios --projectDir path/to/expo
//
// Errors are honest and in Arabic: missing CLI, missing login, invalid project
// dir, and the exact eas exit code. This script never reads or writes
// credentials and never sends anything anywhere except through the eas CLI
// itself running as the current user.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE_RE = /^[A-Za-z0-9._-]{1,48}$/;

/** Usage line shared by --help and the bad-args error. */
const USAGE = "الاستخدام: node scripts/eas-build.mjs --platform android|ios [--profile اسم] [--projectDir مجلد] [--submit] [--local]";

const AR = {
  badArgs: (detail) => `وسائط غير صالحة (${detail}). ${USAGE}`,
  badPlatform: `منصة غير صالحة: القيمة المسموحة android أو ios فقط. ${USAGE}`,
  badProfile: `اسم ملف التعريف (profile) غير صالح: حروف إنجليزية وأرقام ونقاط وشرطات فقط (≤48 حرفًا).`,
  noProjectDir: (dir) => `مجلد المشروع غير موجود: ${dir}. مرّر مجلد مشروع Expo الصحيح عبر --projectDir.`,
  notExpoProject: (dir) => `المجلد ليس مشروع Expo صالحًا (لا يوجد app.json ولا eas.json ولا package.json): ${dir}. صدّر التطبيق من Loam أولًا ثم مرّر مجلد expo المستخرج.`,
  noEasCli: "أداة eas غير مثبتة على هذا الجهاز. ثبّتها بنفسك ثم أعد المحاولة: npm install -g eas-cli — Loam لا يثبّت أدوات خارجية باسمك ولا يخزّن أي مفاتيح.",
  notLoggedIn: "أنت غير مسجّل الدخول في Expo. سجّل الدخول بنفسك بأمر: eas login — حسابك ومفاتيحك تبقى عندك، Loam لا يراها ولا يخزّنها.",
  localIosUnsupported: "البناء المحلي (--local) متاح لأندرويد فقط؛ بناء iOS يحتاج سحابة EAS أو جهاز macOS محلي.",
  buildFailed: (platform, code) => `فشل بناء EAS لمنصة ${platform} (رمز الخروج ${code}). شغّل الأمر يدويًا داخل مجلد المشروع لرؤية التفاصيل: eas build --platform ${platform} --non-interactive`,
  submitFailed: (platform, code) => `فشل إرسال النسخة إلى المتجر لمنصة ${platform} (رمز الخروج ${code}). شغّل يدويًا: eas submit --platform ${platform} --latest`,
};

/** Parses CLI argv into {platform, profile?, projectDir?, submit, local}. Exported for tests. */
export function parseEasArgs(argv) {
  const out = { submit: false, local: false, platform: null, profile: null, projectDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { ok: true, value: { ...out, help: true } };
    if (a === "--submit") { out.submit = true; continue; }
    if (a === "--local") { out.local = true; continue; }
    if (a === "--platform" || a === "--profile" || a === "--projectDir") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return { ok: false, error: AR.badArgs(`${a} يحتاج قيمة`) };
      if (a === "--platform") out.platform = value;
      else if (a === "--profile") out.profile = value;
      else out.projectDir = value;
      i++;
      continue;
    }
    return { ok: false, error: AR.badArgs(`وسيط غير معروف: ${a}`) };
  }
  if (out.platform !== "android" && out.platform !== "ios") return { ok: false, error: AR.badPlatform };
  if (out.profile !== null && !PROFILE_RE.test(out.profile)) return { ok: false, error: AR.badProfile };
  if (out.local && out.platform === "ios") return { ok: false, error: AR.localIosUnsupported };
  return { ok: true, value: out };
}

/** One process run; injectable so tests never invoke the real eas CLI. */
async function defaultRun(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, shell: process.platform === "win32", ...opts });
    let stdout = "";
    let stderr = "";
    if (child.stdout) child.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
    if (child.stderr) child.stderr.on("data", (b) => { stderr += b.toString("utf8"); });
    child.on("error", (err) => resolve({ code: -1, stdout, stderr, spawnError: err }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Resolves the effective project dir: the argument, else ./expo when present, else cwd.
 * Exported for tests.
 */
export function resolveProjectDir(explicit, cwd = process.cwd()) {
  let dir;
  if (explicit) dir = path.resolve(cwd, explicit);
  else {
    const expoDir = path.join(cwd, "expo");
    dir = fs.existsSync(expoDir) ? expoDir : cwd;
  }
  if (!fs.existsSync(dir)) return { ok: false, error: AR.noProjectDir(dir) };
  const hasMarker = ["app.json", "eas.json", "package.json"].some((m) => fs.existsSync(path.join(dir, m)));
  if (!hasMarker) return { ok: false, error: AR.notExpoProject(dir) };
  return { ok: true, value: dir };
}

/**
 * The whole BYOK flow. deps.run is the spawn seam (tests inject a mock; the
 * real default pipes/prints through). Returns {ok:true} or {ok:false,error}.
 */
export async function runEasBuild(opts, deps = {}) {
  const run = deps.run ?? defaultRun;
  const cwd = deps.cwd ?? process.cwd();
  const platform = opts.platform === "ios" ? "ios" : "android";

  const dir = resolveProjectDir(opts.projectDir, cwd);
  if (!dir.ok) return dir;

  // 1) the CLI itself, user-installed
  const version = await run("eas", ["--version"], { cwd: dir });
  if (version.code !== 0 || version.spawnError) return { ok: false, error: AR.noEasCli };

  // 2) the user's own login (BYOK — we never see or store the credentials)
  const who = await run("eas", ["whoami"], { cwd: dir });
  if (who.code !== 0) return { ok: false, error: AR.notLoggedIn };

  // 3) the build (cloud; --local only for android when the user asked for it)
  const buildArgs = ["build", "--platform", platform, "--non-interactive"];
  if (opts.profile) buildArgs.push("--profile", opts.profile);
  if (opts.local && platform === "android") buildArgs.push("--local");
  const build = await run("eas", buildArgs, { cwd: dir, stdio: "inherit" });
  if (build.code !== 0) return { ok: false, error: AR.buildFailed(platform, build.code) };

  // 4) optional store submission of the latest build
  if (opts.submit) {
    const submitArgs = ["submit", "--platform", platform, "--latest", "--non-interactive"];
    if (opts.profile) submitArgs.push("--profile", opts.profile);
    const submit = await run("eas", submitArgs, { cwd: dir, stdio: "inherit" });
    if (submit.code !== 0) return { ok: false, error: AR.submitFailed(platform, submit.code) };
  }
  return { ok: true };
}

// ---- CLI entry ----
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
  const parsed = parseEasArgs(process.argv.slice(2));
  if (!parsed.ok) { console.error(parsed.error); process.exit(2); }
  if (parsed.value.help) { console.log(USAGE); process.exit(0); }
  const result = await runEasBuild(parsed.value);
  if (!result.ok) { console.error(result.error); process.exit(1); }
  console.log("تم بناء التطبيق عبر EAS تحت حسابك الخاص (لم يخزّن Loam أي مفاتيح).");
}
