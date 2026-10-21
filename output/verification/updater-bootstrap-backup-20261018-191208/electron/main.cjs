const { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const updater = require("./updater.cjs");
const mcpBridge = require("./mcp-bridge.cjs");

const ASAR_ROOT = path.resolve(__dirname, "..");
const ROOT =
  ASAR_ROOT.endsWith(".asar") && fs.existsSync(ASAR_ROOT + ".unpacked")
    ? ASAR_ROOT + ".unpacked"
    : ASAR_ROOT;
app.setName("Loam");
if (process.env.LOAM_USER_DATA_DIR) {
  app.setPath("userData", path.resolve(process.env.LOAM_USER_DATA_DIR));
} else if (app.isPackaged) {
  const legacyUserData = path.join(app.getPath("appData"), "manus-local");
  if (fs.existsSync(legacyUserData)) app.setPath("userData", legacyUserData);
}

const PORT = Number(process.env.LOAM_PORT || process.env.MANUS_LOCAL_PORT || 3939);
const BASE = "http://127.0.0.1:" + PORT;
const BRIDGE_PORT = Number(process.env.LOAM_MCP_BRIDGE_PORT || 3002);

process.env.MANUS_LOCAL_ROOT = ROOT;
process.env.MANUS_LOCAL_PORT = String(PORT);
process.env.LOAM_ROOT = ROOT;
process.env.LOAM_PORT = String(PORT);
const EXPECTED_VERSION = require(path.join(ROOT, "package.json")).version;

let serverChild = null;
let win = null;
let tray = null;

// Keep user data (skills, data, workspace) out of the app folder so updates
// never overwrite it. Packaged builds use %APPDATA%/manus-local; dev builds
// keep everything inside the source tree.
function prepareUserData() {
  if (!app.isPackaged) return;
  const userData = app.getPath("userData");
  const dataDir = path.join(userData, "data");
  const skillsDir = path.join(userData, "skills");
  const workspaceDir = path.join(userData, "workspace");
  const evalsDir = path.join(userData, "evals");
  for (const dir of [dataDir, skillsDir, workspaceDir, evalsDir]) fs.mkdirSync(dir, { recursive: true });

  // Seed bundled skills once (only the ones missing).
  try {
    const bundled = path.join(ROOT, "skills");
    for (const entry of fs.readdirSync(bundled, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dest = path.join(skillsDir, entry.name);
      if (!fs.existsSync(dest)) fs.cpSync(path.join(bundled, entry.name), dest, { recursive: true });
    }
  } catch (err) {
    console.error("[electron] seed skills: " + err.message);
  }

  // Seed bundled evaluation suites once (only the ones missing) so approved
  // drafts and edits survive app updates.
  try {
    const bundled = path.join(ROOT, "evals");
    for (const entry of fs.readdirSync(bundled, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
      const dest = path.join(evalsDir, entry.name);
      if (!fs.existsSync(dest)) fs.copyFileSync(path.join(bundled, entry.name), dest);
    }
  } catch (err) {
    console.error("[electron] seed evals: " + err.message);
  }

  // First run: derive a user config with user-data paths.
  const configPath = path.join(userData, "config.json");
  if (!fs.existsSync(configPath)) {
    let cfg = {};
    try {
      cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
    } catch (err) {
      cfg = {};
    }
    cfg.workspace = workspaceDir;
    if (cfg.mcpServers?.["loam-bridge"]) cfg.mcpServers["loam-bridge"].url = `http://127.0.0.1:${BRIDGE_PORT}/mcp`;
    cfg.memory = Object.assign({}, cfg.memory, { file: path.join(dataDir, "memory.json") });
    cfg.computerUse = Object.assign({}, cfg.computerUse, { screenshotDir: path.join(workspaceDir, ".screenshots") });
    try {
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8");
    } catch (err) {
      console.error("[electron] user config: " + err.message);
    }
  }

  process.env.MANUS_LOCAL_CONFIG = configPath;
  process.env.MANUS_LOCAL_DATA_DIR = dataDir;
  process.env.MANUS_LOCAL_SKILLS_DIR = skillsDir;
  process.env.MANUS_LOCAL_EVALS_DIR = evalsDir;
  process.env.LOAM_CONFIG = configPath;
  process.env.LOAM_DATA_DIR = dataDir;
  process.env.LOAM_SKILLS_DIR = skillsDir;
  process.env.LOAM_EVALS_DIR = evalsDir;
  // Add the first-party adapter without overwriting any user-supplied MCP service.
  const userConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  userConfig.mcpServers ||= {};
  if (!userConfig.mcpServers["loam-bridge"] && process.env.LOAM_DISABLE_BRIDGE !== "1") {
    const backup = configPath + ".pre-loam-0.5.0";
    if (!fs.existsSync(backup)) fs.copyFileSync(configPath, backup);
    userConfig.mcpServers["loam-bridge"] = { transport: "http", url: `http://127.0.0.1:${BRIDGE_PORT}/mcp` };
    fs.writeFileSync(configPath, JSON.stringify(userConfig, null, 2), "utf8");
  }
}

function ping() {
  const dataPath = path.resolve(process.env.LOAM_DATA_DIR || process.env.MANUS_LOCAL_DATA_DIR || path.join(ROOT, "data"));
  const profileId = createHash("sha256").update(process.platform === "win32" ? dataPath.toLowerCase() : dataPath).digest("hex");
  return new Promise((resolve) => {
    const req = http.get(BASE + "/api/identity", (res) => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        try { const data = JSON.parse(body); resolve(res.statusCode === 200 && data.application === "Loam" && data.version === EXPECTED_VERSION && data.apiVersion === 1 && data.profileId === profileId); }
        catch { resolve(false); }
      });
    });
    req.on("error", () => resolve(false));
    req.setTimeout(4000, () => { req.destroy(); resolve(false); });
  });
}

async function ensureServer() {
  if (await ping()) return "external";
  const occupied = await new Promise(resolve => {
    const req = http.get(BASE + "/api/config", res => { res.resume(); resolve(true); });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
  if (occupied) throw new Error(`المنفذ ${PORT} تستخدمه نسخة مختلفة. أغلق النسخة السابقة بعد انتهاء مهامها ثم أعد تشغيل Loam.`);
  const bundle = path.join(ROOT, "dist", "server.cjs");
  if (!fs.existsSync(bundle)) throw new Error("dist/server.cjs missing - run: npm run build:server");
  for (let attempt = 1; attempt <= 3; attempt++) {
    const nodePaths = [
      path.join(ROOT, "node_modules"),
      path.join(ASAR_ROOT, "node_modules"),
      process.env.NODE_PATH || "",
    ]
      .filter(Boolean)
      .join(path.delimiter);
    serverChild = spawn(process.execPath, [bundle], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        ELECTRON_RUN_AS_NODE: "1",
        MANUS_LOCAL_ROOT: ROOT,
        MANUS_LOCAL_PORT: String(PORT),
        NODE_PATH: nodePaths,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let exited = false;
    serverChild.on("exit", () => { exited = true; });
    serverChild.on("error", error => { exited = true; console.error("[electron] server: " + error.message); });
    serverChild.stdout.on("data", (d) => process.stdout.write("[server] " + d));
    serverChild.stderr.on("data", (d) => process.stderr.write("[server] " + d));
    const startupDeadline = Date.now() + 120_000;
    while (Date.now() < startupDeadline) {
      if (await ping()) return attempt === 1 ? "spawned" : "spawned-retry" + attempt;
      if (exited) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!exited) {
      // Keep ownership of this live child; never overwrite it with another attempt.
      try { serverChild.kill(); } catch {}
      throw new Error("انتهت مهلة بدء خادم Loam. راجع اتصال خدمات MCP ثم أعد التشغيل.");
    }
    if (exited && attempt < 3) {
      console.error("[electron] server exited early; retrying in 2s (port may still be in use)");
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    if (attempt === 3) throw new Error("server did not become ready after 3 attempts");
  }
  return "unknown";
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600,
    title: "Loam", backgroundColor: "#080b12", autoHideMenuBar: false,
    icon: path.join(__dirname, "assets", "loam.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  let reloadAttempts = 0;
  win.webContents.on("did-fail-load", () => {
    if (reloadAttempts >= 10) return;
    reloadAttempts += 1;
    setTimeout(() => {
      if (win) void win.loadURL(BASE + "/");
    }, 2000);
  });
  void win.loadURL(BASE + "/");
  win.webContents.setWindowOpenHandler((arg) => { void shell.openExternal(arg.url); return { action: "deny" }; });
  win.on("closed", () => { win = null; });
}

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function openPage(p) {
  showWindow();
  if (win) void win.loadURL(BASE + p);
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, "assets", "loam.png")).resize({ width: 32, height: 32 });
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  } catch (e) { tray = new Tray(nativeImage.createEmpty()); }
  tray.setToolTip("Loam");
  const menu = Menu.buildFromTemplate([
    { label: "فتح Loam", click: showWindow },
    { label: "مهمة جديدة", click: () => openPage("/") },
    { type: "separator" },
    { label: "الشاشة الحيّة", click: () => openPage("/screen.html") },
    { label: "الطرفية", click: () => openPage("/terminal.html") },
    { label: "الذاكرة", click: () => openPage("/memory.html") },
    { label: "المهارات", click: () => openPage("/skills.html") },
    { type: "separator" },
    { type: "separator" },
    { label: "التحقق من التحديثات…", click: () => { void updater.checkInteractive(); } },
    { label: "تثبيت التحديث وإعادة التشغيل", click: () => { if (!updater.installNow()) void updater.checkInteractive(); } },
    { type: "separator" },
    { label: "خروج", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", showWindow);
}

function buildMenu() {
  const template = [
    { label: "عرض", submenu: [
      { label: "الرئيسية", accelerator: "CmdOrCtrl+1", click: () => openPage("/") },
      { label: "الشاشة الحيّة", accelerator: "CmdOrCtrl+2", click: () => openPage("/screen.html") },
      { label: "الطرفية", accelerator: "CmdOrCtrl+3", click: () => openPage("/terminal.html") },
      { label: "الذاكرة", accelerator: "CmdOrCtrl+4", click: () => openPage("/memory.html") },
      { label: "المهارات", accelerator: "CmdOrCtrl+5", click: () => openPage("/skills.html") },
      { type: "separator" },
      { role: "reload" }, { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
    ] },
    { label: "ملف", submenu: [
      { label: "التحقق من التحديثات…", click: () => { void updater.checkInteractive(); } },
      { type: "separator" },
      { role: "quit", label: "خروج" },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.setAppUserModelId("app.loam.desktop");

// Native folder picker for choosing the working repo/folder.
ipcMain.handle("pick-folder", async () => {
  try {
    const res = await dialog.showOpenDialog(win ?? undefined, {
      title: "اختر مجلد المشروع",
      properties: ["openDirectory", "createDirectory"],
    });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  } catch (err) {
    console.error("[electron] pick-folder: " + err.message);
    return null;
  }
});

const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

app.whenReady().then(async () => {
  if (!ownsInstance) return;
  prepareUserData();
  buildMenu();
  createTray();
  await mcpBridge.start(ROOT, BRIDGE_PORT);
  try { console.log("[electron] server mode: " + (await ensureServer())); }
  catch (err) { console.error("[electron] " + err.message); dialog.showErrorBox("Loam — تعذّر بدء التشغيل", err.message); app.quit(); return; }
  createWindow();
  startServerWatchdog();
  updater.init({
    onStatus: (s) => {
      const label = s && s.state === "downloaded" ? "تحديث جاهز" : s && s.state ? s.state : "idle";
      if (tray) tray.setToolTip("Loam — " + label);
    },
  });
});

// ---------------------------------------------------------------------------
// Loam watchdog: if the server child freezes (unresponsive event loop),
// it is killed and respawned automatically so the app never stays dead.
// ---------------------------------------------------------------------------
let watchdogFailures = 0;
let watchdogRestarting = false;
function startServerWatchdog() {
  setInterval(async () => {
    if (watchdogRestarting || quitting) return;
    const ok = await ping();
    if (ok) {
      watchdogFailures = 0;
      return;
    }
    watchdogFailures += 1;
    if (watchdogFailures < 12) return;
    watchdogFailures = 0;
    if (!serverChild) {
      console.error("[electron] watchdog: external server unresponsive (not ours to restart)");
      return;
    }
    console.error("[electron] watchdog: server unresponsive 3x — killing and respawning server child");
    try { serverChild.kill(); } catch (e) {}
    serverChild = null;
    watchdogRestarting = true;
    try { await ensureServer(); } catch (err) { console.error("[electron] watchdog respawn failed: " + err.message); }
    finally { watchdogRestarting = false; }
  }, 10_000);
}

app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on("window-all-closed", () => app.quit());
let quitting = false;
app.on("before-quit", (event) => {
  if (!quitting) {
    event.preventDefault(); quitting = true;
    void mcpBridge.stop().finally(() => app.quit());
  }
  if (tray) { tray.destroy(); tray = null; }
  if (serverChild) { try { serverChild.kill(); } catch (e) {} }
});
