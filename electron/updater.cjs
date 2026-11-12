// Auto-update for Loam via electron-updater against a private feed.
// Generic (static-host) feed: <url>/latest.yml + the NSIS installer.
//
// The feed URL is overridable with MANUS_LOCAL_UPDATE_URL so you can point a
// dev/test build at a local feed without rebuilding.

const { app, dialog, Notification } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_FEED_URL = "http://127.0.0.1:8788/";
const AUTO_CHECK_MS = 4 * 60 * 60 * 1000; // 4 hours

let updater = null;
let timer = null;
let installing = false;
let latest = { state: "idle", updatedAt: new Date().toISOString() };
let localFeed = '';
let canInstall = async () => true;
let checkPending = null;
let onStatus = () => {};
let building = false;

function readSavedFeedUrl() {
  const candidates = [];
  if (process.env.MANUS_LOCAL_DATA_DIR) candidates.push(path.join(process.env.MANUS_LOCAL_DATA_DIR, "settings.json"));
  try {
    candidates.push(path.join(app.getPath("userData"), "data", "settings.json"));
  } catch {
    /* before ready */
  }
  if (process.env.MANUS_LOCAL_ROOT) candidates.push(path.join(process.env.MANUS_LOCAL_ROOT, "data", "settings.json"));
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const st = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof st.updateFeedUrl === "string" && st.updateFeedUrl.trim()) return st.updateFeedUrl.trim();
      if (typeof st.githubRepo === "string" && st.githubRepo.trim()) {
        return `https://github.com/${st.githubRepo.trim().replace(/^\/+|\/+$/g, "")}/releases/latest/download/`;
      }
    } catch {
      /* ignore */
    }
  }
  return "";
}

function feedUrl() {
  // LOAM_UPDATE_FEED_URL is the canonical override (generic provider feed,
  // e.g. a local test feed from scripts/updater-test-feed.mjs); the older
  // aliases keep working.
  const fromEnv = (process.env.LOAM_UPDATE_FEED_URL || process.env.LOAM_UPDATE_URL || process.env.MANUS_LOCAL_UPDATE_URL || "").trim();
  if (fromEnv) return fromEnv;
  const fromSettings = readSavedFeedUrl();
  if (fromSettings) return fromSettings;
  const ghRepo = (process.env.LOAM_GITHUB_REPO || process.env.MANUS_GITHUB_REPO || "").trim();
  if (ghRepo) return `https://github.com/${ghRepo.replace(/^\/+|\/+$/g, "")}/releases/latest/download/`;
  // P0.3: the product channel. localFeed stays the local-channel test path;
  // packaged installs without any override update from the project's GitHub
  // Releases feed instead of the dev fallback.
  if (localFeed) return localFeed;
  return `https://github.com/${DEFAULT_GITHUB_REPO}/releases/latest/download/`;
}
const DEFAULT_GITHUB_REPO = "khamis1992/loam";

function versionParts(value) {
  return String(value || "").split("-")[0].split(".").map((part) => {
    const n = Number(part);
    return Number.isFinite(n) ? n : 0;
  });
}

/** 1 when left is newer, -1 when older, 0 when the numeric versions match. */
function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function setState(patch) {
  latest = Object.assign({}, latest, patch, { at: new Date().toISOString() });
  try { onStatus(getStatus()); } catch { /* UI callbacks must not interrupt updates. */ }
  return latest;
}

function getStatus() {
  return { ...latest, currentVersion: app.getVersion(), localChannel: feedUrl() === localFeed };
}

function loadUpdater() {
  if (updater) return updater;
  try {
    updater = require("electron-updater").autoUpdater;
  } catch (err) {
    updater = null;
    setState({ state: "disabled", reason: "electron-updater is not installed" });
  }
  return updater;
}

function isDisabled() {
  if (!app.isPackaged && process.env.MANUS_LOCAL_DEV_UPDATE !== "1") {
    return "Updates are disabled in an unpackaged build.";
  }
  return null;
}

function rememberUpdater(level, message) {
  const line = new Date().toISOString() + " [updater] " + level + " " + message + "\n";
  if (level === "error") console.error(line.trim());
  try { fs.appendFileSync(path.join(app.getPath("userData"), "updater.log"), line); } catch { /* before the app is ready, or in tests */ }
}

function wire(u) {
  u.autoDownload = true;
  u.autoInstallOnAppQuit = false;
  u.disableDifferentialDownload = true;
  u.allowPrerelease = false;
  u.logger = {
    info: (m) => rememberUpdater("info", m),
    warn: (m) => rememberUpdater("warn", m),
    error: (m) => rememberUpdater("error", m),
  };

  u.on("checking-for-update", () => setState({ state: "checking" }));
  u.on("update-available", (info) => setState({ state: "available", version: info && info.version, checkedAt: new Date().toISOString() }));
  u.on("update-not-available", (info) => {
    const version = info && info.version;
    // An older file on the local channel is not a broken feed. The installed
    // build is simply ahead of it, so this is "up to date", not a mismatch.
    const state = !version || compareVersions(app.getVersion(), version) >= 0 ? "current" : "channel-mismatch";
    setState({ state, version, checkedAt: new Date().toISOString() });
  });
  u.on("download-progress", (p) =>
    setState({ state: "downloading", percent: p && Math.round(p.percent || 0) }));
  u.on("update-downloaded", (info) => {
    const version = (info && info.version) || "unknown";
    setState({ state: "downloaded", version });

  });
  u.on("error", (err) => setState({ state: "error", reason: err ? String(err.message || err) : "unknown" }));
}

function init(options) {
  const opts = options || {};
  localFeed = opts.localFeed || '';
  canInstall = opts.canInstall || canInstall;
  onStatus = opts.onStatus || (() => {});
  if (opts.onStatus) {
    try { opts.onStatus(getStatus()); } catch (err) { /* ignore */ }
  }
  const disabled = isDisabled();
  if (disabled) {
    setState({ state: "disabled", reason: disabled });
    if (opts.onStatus) { try { opts.onStatus(getStatus()); } catch (err) {} }
    return getStatus();
  }
  const u = loadUpdater();
  if (!u) return getStatus();

  if (process.env.MANUS_LOCAL_DEV_UPDATE === "1") {
    try { u.forceDevUpdateConfig = true; } catch (err) { /* older electron-updater */ }
  }
  try {
    u.setFeedURL({ provider: "generic", url: feedUrl(), useMultipleRangeRequest: false });
  } catch (err) {
    setState({ state: "error", reason: "cannot set feed url: " + (err && err.message) });
    return getStatus();
  }
  wire(u);
  setState({ state: "idle", feed: feedUrl() });
  void check().catch(() => {});
  if (timer) clearInterval(timer);
  timer = setInterval(() => { void check().catch(() => {}); }, AUTO_CHECK_MS);
  return getStatus();
}

async function checkInteractive() {
  let result = await check();
  const deadline = Date.now() + 15 * 60 * 1000;
  while ((result.state === 'available' || result.state === 'downloading') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    result = getStatus();
  }
  const detail = 'الإصدار المثبت: '+app.getVersion()+'\nالإصدار المنشور: '+(result.version || 'غير معروف')+'\nالمصدر: '+(result.localChannel?'قناة محلية على هذا الجهاز. لا تتحقق من إصدارات الإنترنت.':'قناة التحديث المحددة.')+(result.checkedAt?'\nوقت الفحص: '+new Date(result.checkedAt).toLocaleString('ar-SA'):'');
  if (result.state === 'downloaded') {
    const choice = await dialog.showMessageBox({
      type: 'info',
      title: 'التحديثات',
      message: 'تم تنزيل التحديث ' + (result.version || '') + '.',
      detail: 'أعد تشغيل التطبيق لتثبيت هذه النسخة.',
      buttons: ['إعادة التشغيل الآن', 'لاحقاً'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response === 0) {
      try { await installNow(); } catch (error) {
        await dialog.showMessageBox({ type: 'warning', title: 'التحديثات', message: error && error.message ? error.message : 'تعذّر تثبيت التحديث.' });
      }
    }
    return result;
  }
  if (result.state === 'current') {
    const ahead = result.version && compareVersions(app.getVersion(), result.version) > 0;
    const message = ahead
      ? 'الإصدار المثبت أحدث من المنشور على قناة التحديث. لا يوجد تحديث جديد.'
      : (result.localChannel ? 'الإصدار المثبت يطابق آخر إصدار منشور محليًا.' : 'الإصدار المثبت يطابق آخر إصدار على القناة المحددة.');
    const offerBuild = !ahead && result.localChannel;
    const extra = ahead
      ? '\nلبناء تحديث يظهر هنا، ارفع رقم الإصدار ثم أعد بناء الحزمة.'
      : (offerBuild ? '\nاضغط «تثبيت التحديثات» لبناء آخر تعديلات المشروع وتثبيتها الآن.' : '');
    const choice = await dialog.showMessageBox({
      type: 'info',
      title: 'التحديثات',
      message,
      detail: detail + extra,
      buttons: offerBuild ? ['تثبيت التحديثات', 'إغلاق'] : ['حسنًا'],
      defaultId: 0,
      cancelId: offerBuild ? 1 : 0,
    });
    if (offerBuild && choice.response === 0) {
      try { await applyLocalUpdate(); }
      catch (error) {
        await dialog.showMessageBox({ type: 'warning', title: 'التحديثات', message: error && error.message ? error.message : 'تعذّر تثبيت التحديث.' });
      }
    }
  }
  if (result.state === 'channel-mismatch') await dialog.showMessageBox({type:'warning',title:'التحديثات',message:'قناة التحديث تعرض إصدارًا مختلفًا ولا توفر ترقية أحدث متوافقة.',detail});
  if (result.state === 'error' || result.state === 'disabled') await dialog.showMessageBox({type:'info',title:'التحديثات',message:result.localChannel?'لم يتوفر إصدار محلي منشور. أعد المحاولة بعد نشر التحديث.':'تعذّر التحقق من التحديثات. أعد المحاولة.'});
  if (result.state === 'downloading' || result.state === 'available') await dialog.showMessageBox({type:'warning',title:'التحديثات',message:'لم يكتمل تنزيل التحديث. أعد المحاولة.'});
  return result;
}

async function check() {
  const disabled = isDisabled();
  if (disabled) { setState({ state: 'disabled', reason: disabled });return getStatus(); }
  const downloadedIsNewer = latest.state === 'downloaded' && compareVersions(latest.version, app.getVersion()) > 0;
  if (downloadedIsNewer || ['downloading', 'installing'].includes(latest.state)) return getStatus();
  if (checkPending) { await checkPending;return getStatus(); }
  const u = loadUpdater();if (!u) return getStatus();
  // Settings may change while the app is running.
  setState({ state: 'checking', reason: '', percent: 0, version: null, checkedAt: null });
  checkPending = Promise.resolve().then(() => {
    u.setFeedURL({ provider: 'generic', url: feedUrl(), useMultipleRangeRequest: false });
    return u.checkForUpdates();
  }).catch(err => setState({ state: 'error', reason: String(err.message || err) })).finally(() => { checkPending = null; });
  await checkPending;return getStatus();
}

function isLoamSource(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return pkg.name === "loam" && fs.existsSync(path.join(dir, "electron", "main.cjs"));
  } catch {
    return false;
  }
}

function sourceRoot() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const candidates = [
    process.env.LOAM_SOURCE_ROOT,
    process.env.MANUS_LOCAL_SOURCE,
  ];
  try {
    const saved = path.join(app.getPath("userData"), "source-root.txt");
    if (fs.existsSync(saved)) candidates.push(fs.readFileSync(saved, "utf8").trim());
  } catch { /* user data is not ready */ }
  if (home) {
    candidates.push(path.join(home, "Desktop", "manus-local"));
    candidates.push(path.join(home, "Documents", "manus-local"));
  }
  return candidates.find((dir) => dir && isLoamSource(dir)) || "";
}

function ensureNewerVersion(root) {
  const file = path.join(root, "package.json");
  const raw = fs.readFileSync(file, "utf8");
  const current = raw.match(/"version":\s*"([^"]+)"/)?.[1] || "0.0.0";
  const installed = app.getVersion();
  if (compareVersions(current, installed) > 0) return current;
  const parts = versionParts(installed);
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  const next = parts.join(".");
  fs.writeFileSync(file, raw.replace(/"version":\s*"[^"]+"/, `"version": "${next}"`));
  return next;
}

function runDist(root) {
  return new Promise((resolve, reject) => {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(npm, ["run", "dist:update"], {
      cwd: root,
      shell: true,
      windowsHide: true,
      env: { ...process.env, LOAM_RELEASE_DIR: "release-build" },
    });
    let tail = "";
    const take = (chunk) => { tail = (tail + chunk.toString()).slice(-1200); };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("تعذّر بناء التحديث.\n" + tail.trim()));
    });
  });
}

async function applyLocalUpdate() {
  if (latest.state === "downloaded") return installNow();
  if (building) return getStatus();
  const root = sourceRoot();
  if (!root) throw new Error("لم يُعثر على مشروع Loam. ضع المجلد على سطح المكتب باسم manus-local ثم أعد المحاولة.");
  building = true;
  const version = ensureNewerVersion(root);
  setState({ state: "downloading", version, percent: 0, reason: "building" });
  try {
    if (Notification && Notification.isSupported && Notification.isSupported()) {
      new Notification({ title: "Loam", body: "جارٍ بناء التحديث " + version + " ثم تثبيته." }).show();
    }
    await runDist(root);
    setState({ state: "idle", version });
    let result = await check();
    const deadline = Date.now() + 20 * 60 * 1000;
    while ((result.state === "checking" || result.state === "available" || result.state === "downloading") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      result = getStatus();
    }
    if (result.state !== "downloaded") throw new Error("اكتمل البناء ولم يبدأ التثبيت. اضغط التحقق من التحديثات.");
    return installNow();
  } finally {
    building = false;
  }
}

async function installNow() {
  if (latest.state !== 'downloaded' || installing) return false;
  installing = true;
  try { if (!await canInstall()) throw new Error('انتظر انتهاء المهام الجارية قبل تثبيت التحديث.'); } catch (error) { installing = false;throw error; }
  const u = loadUpdater();
  if (!u) { installing = false;return false; }
  try { setState({ state: 'installing' });u.quitAndInstall(true, true); return true; } catch (err) { installing = false;setState({ state: 'error', reason: String(err.message || err) });return false; }
}

module.exports = { init, check, checkInteractive, installNow, applyLocalUpdate, getStatus, feedUrl, ensureNewerVersion };
