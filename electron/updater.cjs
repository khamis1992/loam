// Auto-update for Loam via electron-updater against a private feed.
// Generic (static-host) feed: <url>/latest.yml + the NSIS installer.
//
// The feed URL is overridable with MANUS_LOCAL_UPDATE_URL so you can point a
// dev/test build at a local feed without rebuilding.

const { app, dialog } = require("electron");
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
  return localFeed || DEFAULT_FEED_URL;
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

function wire(u) {
  u.autoDownload = true;
  u.autoInstallOnAppQuit = false;
  u.allowPrerelease = false;
  u.logger = { info: () => {}, warn: () => {}, error: (m) => console.error("[updater] " + m) };

  u.on("checking-for-update", () => setState({ state: "checking" }));
  u.on("update-available", (info) => setState({ state: "available", version: info && info.version, checkedAt: new Date().toISOString() }));
  u.on("update-not-available", (info) => {
    const version = info && info.version;
    setState({ state: version === app.getVersion() ? 'current' : 'channel-mismatch', version, checkedAt: new Date().toISOString() });
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
  const result = await check();
  const detail = 'الإصدار المثبت: '+app.getVersion()+'\nالإصدار المنشور: '+(result.version || 'غير معروف')+'\nالمصدر: '+(result.localChannel?'قناة محلية على هذا الجهاز. لا تتحقق من إصدارات الإنترنت.':'قناة التحديث المحددة.')+(result.checkedAt?'\nوقت الفحص: '+new Date(result.checkedAt).toLocaleString('ar-SA'):'');
  if (result.state === 'current') await dialog.showMessageBox({type:'info',title:'التحديثات',message:result.localChannel?'الإصدار المثبت يطابق آخر إصدار منشور محليًا.':'الإصدار المثبت يطابق آخر إصدار على القناة المحددة.',detail:detail+(result.localChannel?'\nتعديلات التطوير لا تصل إلى التطبيق حتى تُحزم وتُنشر برقم إصدار جديد.':'')});
  if (result.state === 'channel-mismatch') await dialog.showMessageBox({type:'warning',title:'التحديثات',message:'قناة التحديث تعرض إصدارًا مختلفًا ولا توفر ترقية أحدث متوافقة.',detail});
  if (result.state === 'error' || result.state === 'disabled') await dialog.showMessageBox({type:'info',title:'التحديثات',message:result.localChannel?'لم يتوفر إصدار محلي منشور. أعد المحاولة بعد نشر التحديث.':'تعذّر التحقق من التحديثات. أعد المحاولة.'});
  return result;
}

async function check() {
  const disabled = isDisabled();
  if (disabled) { setState({ state: 'disabled', reason: disabled });return getStatus(); }
  if (['downloaded','downloading','installing'].includes(latest.state)) return getStatus();
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

async function installNow() {
  if (latest.state !== 'downloaded' || installing) return false;
  installing = true;
  try { if (!await canInstall()) throw new Error('انتظر انتهاء المهام الجارية قبل تثبيت التحديث.'); } catch (error) { installing = false;throw error; }
  const u = loadUpdater();
  if (!u) { installing = false;return false; }
  try { setState({ state: 'installing' });u.quitAndInstall(); return true; } catch (err) { installing = false;setState({ state: 'error', reason: String(err.message || err) });return false; }
}

module.exports = { init, check, checkInteractive, installNow, getStatus, feedUrl };
