const { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog, ipcMain, protocol } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const updater = require("./updater.cjs");
const inAppBrowser = require("./inAppBrowser.cjs");
const mcpBridge = require("./mcp-bridge.cjs");
const { IPC_INVOKE, IPC_EVENT_PREFIX, IPC_META, IPC_SYNC, NAMESPACES } = require("./ipc-constants.cjs");

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

const WEB_OUT = path.join(ROOT, "packages", "web", "out");
const APP_ORIGIN = "app://agent";
const AGENT_STUDIO_BACKEND = "http://127.0.0.1:8787";
const MIME_TYPES = {
  ".html": "text/html", ".txt": "text/plain", ".css": "text/css", ".js": "application/javascript",
  ".mjs": "application/javascript", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf", ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm",
};

let serverChild = null;
let win = null;
let tray = null;
let localAuthToken = "";
let localAuthUserData = "";
let pendingLoginNonce = "";
let sessionToken = "";
let loamServerReady = false;
let pendingDeepLink = null;

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
    const req = http.get(BASE + "/api/identity", { headers: authHeader(localAuthToken) }, (res) => {
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

function isAgentStudioUI() {
  return process.env.AGENT_STUDIO_LEGACY_UI !== "1";
}

function startUrl() {
  return isAgentStudioUI() ? APP_ORIGIN + "/" : BASE + "/";
}

function createWindow() {
  const legacy = !isAgentStudioUI();
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
  const url = startUrl();
  let reloadAttempts = 0;
  win.webContents.on("did-fail-load", () => {
    if (reloadAttempts >= 10) return;
    reloadAttempts += 1;
    setTimeout(() => {
      if (win) void win.loadURL(url);
    }, 2000);
  });
  void win.loadURL(url);
  win.webContents.setWindowOpenHandler((arg) => { void shell.openExternal(arg.url); return { action: "deny" }; });
  // The in-app browser's native WebContentsView ignores CSS stacking, so the
  // window itself must drive the window-side visibility factor: it can only be
  // painted while this window is focused and not minimized/hidden. The
  // renderer's iabSetVisible stays the other AND half; re-showing on focus/
  // restore/show re-paints only if the renderer still wants the view.
  const iabWindowHide = () => inAppBrowser.setWindowAllows(false);
  const iabWindowRestore = () => inAppBrowser.setWindowAllows(true);
  win.on("blur", iabWindowHide);
  win.on("minimize", iabWindowHide);
  win.on("hide", iabWindowHide);
  win.on("focus", iabWindowRestore);
  win.on("restore", iabWindowRestore);
  win.on("show", iabWindowRestore);
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
  if (!win) return;
  // In the new Agent Studio UI there is only the single-page app root; legacy
  // mode keeps the old Loam page navigation.
  if (isAgentStudioUI()) {
    void win.loadURL(startUrl());
  } else {
    void win.loadURL(BASE + p);
  }
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
    { label: "تثبيت التحديث وإعادة التشغيل", click: () => { void updater.installNow().then(ok => { if (!ok) return updater.checkInteractive(); }).catch(error => dialog.showErrorBox("التحديث", error.message)); } },
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

// ---------------------------------------------------------------------------
// Spec IPC registry (BUILD_SPEC §8.3 / §10.3).  MVP namespaces are implemented
// here; the rest are stubbed so the channel surface is complete and the sender
// is always validated before any handler runs.
// ---------------------------------------------------------------------------
const TRUSTED_EXTERNAL_SCHEMES = new Set(["https:", "mailto:"]);
const TRUSTED_EXTERNAL_HOSTS = new Set(["localhost:8787", "127.0.0.1:8787"]);
function isTrustedExternalUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" && TRUSTED_EXTERNAL_HOSTS.has(u.host)) return true;
    return TRUSTED_EXTERNAL_SCHEMES.has(u.protocol);
  } catch {
    return false;
  }
}

function localStoragePath() {
  return path.join(app.getPath("userData"), "localStorage.json");
}
function readLocalStorage() {
  try { return JSON.parse(fs.readFileSync(localStoragePath(), "utf8")); } catch { return {}; }
}
function writeLocalStorage(data) {
  fs.writeFileSync(localStoragePath(), JSON.stringify(data, null, 2), "utf8");
}

function currentWindow() {
  return BrowserWindow.getFocusedWindow() ?? win;
}

function isValidIpcSender(frame) {
  const url = frame?.url ?? "";
  // Trust the legacy Loam loopback origin and the new Agent Studio app origin.
  return url.startsWith(BASE + "/") || url === BASE + "/" || url.startsWith(APP_ORIGIN + "/");
}

let currentTheme = "system";

const ipcHandlers = {
  auth: {
    getToken: () => sessionToken,
    setToken: (_sender, token) => {
      pendingLoginNonce = String(token ?? "");
      if (pendingLoginNonce) {
        // Persist the pending login nonce so the agentstudio:// deep-link
        // callback still matches after a full app restart (Windows relaunches
        // the app for the callback, so the in-memory nonce would be lost).
        const data = readLocalStorage();
        data["login_nonce"] = pendingLoginNonce;
        writeLocalStorage(data);
      }
    },
    removeToken: () => {
      sessionToken = "";
      const data = readLocalStorage();
      delete data["session_token"];
      delete data["login_nonce"];
      writeLocalStorage(data);
    },
    notifyLoginSuccess: () => undefined,
  },
  window: {
    minimize: () => { currentWindow()?.minimize(); },
    maximize: () => { currentWindow()?.maximize(); },
    close: () => { currentWindow()?.close(); },
    isMaximized: () => currentWindow()?.isMaximized() ?? false,
    toggleFullscreen: () => {
      const w = currentWindow();
      if (!w) return false;
      w.setFullScreen(!w.isFullScreen());
      return w.isFullScreen();
    },
    isFullscreen: () => currentWindow()?.isFullScreen() ?? false,
    openTaskInNewWindow: (_sender, _opts) => { throw new Error("not implemented"); },
  },
  system: {
    openExternal: (_sender, url) => {
      if (!isTrustedExternalUrl(url)) throw new Error("disallowed external URL");
      shell.openExternal(url);
    },
    showFolderDialog: async (_sender, opts = {}) => {
      const result = await dialog.showOpenDialog(currentWindow() ?? undefined, {
        properties: ["openDirectory", "createDirectory"],
        defaultPath: opts.defaultPath,
      });
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    },
    showOpenFileDialog: async (_sender, opts = {}) => {
      const properties = ["openFile"];
      if (opts?.multiple) properties.push("multiSelections");
      const result = await dialog.showOpenDialog(currentWindow() ?? undefined, {
        properties,
        defaultPath: opts.defaultPath,
        filters: opts.filters,
      });
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths;
    },
    readFile: async (_sender, filePath) => {
      if (typeof filePath !== "string") throw new Error("path must be a string");
      const resolved = path.resolve(filePath);
      const data = await fs.promises.readFile(resolved);
      const ext = path.extname(resolved).toLowerCase();
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      return { name: path.basename(resolved), base64: data.toString("base64"), mime };
    },
    notifyNetworkOnline: () => undefined,
    notifyNetworkOffline: () => undefined,
  },
  updater: {
    getStatus: () => updater.getStatus(),
    checkForUpdates: () => { void updater.check(); return updater.getStatus(); },
    restartNow: () => updater.installNow(),
    getPolicyContext: () => ({ storeManaged: false, platform: process.platform, channel: updater.feedUrl() }),
  },
  theme: {
    broadcastConfig: (_sender, { theme }) => {
      if (typeof theme === "string") currentTheme = theme;
      return { theme: currentTheme };
    },
  },
  appearance: {
    broadcastConfig: (_sender, cfg) => cfg,
  },
  desktopOperator: {
    listWorkspaceDirectory: (_sender, _opts) => ({ entries: [] }),
    searchWorkspaceFiles: (_sender, _opts) => ({ results: [] }),
    watchWorkspaceFiles: (_sender, _opts) => undefined,
    unwatchWorkspaceFiles: (_sender, _opts) => undefined,
    getState: () => ({}),
  },
  terminal: {
    create: (_sender, _opts) => { throw new Error("terminal not implemented in this build"); },
    write: (_sender, _id, _data) => undefined,
    resize: (_sender, _id, _cols, _rows) => undefined,
    close: (_sender, _id) => undefined,
  },
  desktopActivityIndicator: {
    getState: () => ({}),
    rendererReady: () => undefined,
    setEnabled: (_sender, _enabled) => undefined,
    setExpanded: (_sender, _expanded) => undefined,
  },
  keepAwake: {
    getState: () => ({ enabled: false }),
    setEnabled: (_sender, _enabled) => undefined,
  },
  shortcut: {
    getConfig: () => ({}),
    getCapabilities: () => ({}),
    setEnabled: (_sender, _enabled) => undefined,
  },
  env: {
    setOverrideAndRelaunch: (_sender, _opts) => { throw new Error("not implemented"); },
  },
  inAppBrowser: inAppBrowser.handlers,
  diagnosticLogs: {
    collect: () => ({ path: "" }),
  },
  storage: {
    getItem: (_sender, key) => {
      if (typeof key !== "string") throw new Error("key must be a string");
      return readLocalStorage()[key] ?? null;
    },
    setItem: (_sender, key, value) => {
      if (typeof key !== "string") throw new Error("key must be a string");
      const data = readLocalStorage();
      data[key] = value;
      writeLocalStorage(data);
    },
    removeItem: (_sender, key) => {
      if (typeof key !== "string") throw new Error("key must be a string");
      const data = readLocalStorage();
      delete data[key];
      writeLocalStorage(data);
    },
  },
};

ipcMain.handle(IPC_INVOKE, (event, { ns, method, args }) => {
  if (!isValidIpcSender(event.senderFrame)) throw new Error("invalid IPC sender");
  const handler = ipcHandlers[ns]?.[method];
  if (!handler) throw new Error(`unknown IPC call ${ns}.${method}`);
  return handler(event.sender, ...args);
});

ipcMain.handle(IPC_META, () => ({
  handlers: NAMESPACES.map((ns) => [ns, Object.keys(ipcHandlers[ns] ?? {})]),
  events: [],
}));

ipcMain.on(IPC_SYNC, (event) => {
  event.returnValue = {
    platform: process.platform,
    appVersion: app.getVersion(),
    windowId: currentWindow()?.id ?? 0,
    locale: app.getLocale(),
  };
});

app.setAppUserModelId("app.loam.desktop");

// Register the privileged custom protocol used to serve the Agent Studio UI,
// plus the loamfilm:// protocol used to serve the vendored Loam Video wasm video
// editor from electron/filmcraft/dist and the loameffect:// protocol used to
// serve the vendored Loam Effects wasm engine from electron/effectcraft/dist.
// Both must be registered before app ready.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: "loamfilm", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: "loameffect", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

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

function getLocalAuthToken() {
  const userData = app.getPath("userData");
  const tokenFile = path.join(userData, ".loam-local-auth-token");
  try {
    if (fs.existsSync(tokenFile)) {
      const token = fs.readFileSync(tokenFile, "utf8").trim();
      if (token.length > 0) return { userData, token };
    }
  } catch {}
  const token = require("node:crypto").randomBytes(32).toString("hex");
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(tokenFile, token, "utf8");
  try { fs.chmodSync(tokenFile, 0o600); } catch {}
  return { userData, token };
}

function authHeader(token) {
  return { "x-loam-local-token": token };
}

function findDeepLinkArg(argv) {
  for (const arg of argv) {
    if (typeof arg === "string" && arg.startsWith("agentstudio://")) return arg;
  }
  return null;
}

async function exchangeAgentStudioSession(loginToken) {
  const gen = await fetch(AGENT_STUDIO_BACKEND + "/user.v1.UserAuthService/GenerateTempAuthCode", {
    method: "POST",
    headers: { "Authorization": `Bearer ${loginToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!gen.ok) throw new Error(`GenerateTempAuthCode failed: ${gen.status}`);
  const genData = await gen.json();
  if (!genData.token) throw new Error("no temp auth code returned");
  const exch = await fetch(AGENT_STUDIO_BACKEND + "/user.v1.UserAuthPublicService/ExchangeTokenByCode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: genData.token }),
  });
  if (!exch.ok) throw new Error(`ExchangeTokenByCode failed: ${exch.status}`);
  const exchData = await exch.json();
  if (!exchData.token) throw new Error("no session token returned");
  return exchData.token;
}

async function handleDeepLinkCallback(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "agentstudio:" || u.host !== "auth" || u.pathname !== "/callback") return;
    const loginToken = u.searchParams.get("token");
    const nonce = u.searchParams.get("nonce");
    if (!loginToken || !nonce) throw new Error("missing token or nonce");
    // The nonce was registered with auth.setToken either in this process
    // (in-memory) or in a previous one (persisted alongside session_token);
    // a restarted app must still accept the callback that was started there.
    if (nonce !== pendingLoginNonce && nonce !== (readLocalStorage()["login_nonce"] ?? "")) throw new Error("nonce mismatch");

    sessionToken = await exchangeAgentStudioSession(loginToken);
    const data = readLocalStorage();
    data["session_token"] = sessionToken;
    delete data["login_nonce"];
    writeLocalStorage(data);

    if (win) {
      win.webContents.send("desktop-ipc-event:auth:onLoginSuccess", {});
      showWindow();
    }
    console.log("[electron] Agent Studio sign-in complete");
  } catch (err) {
    console.error("[electron] deep link callback error: " + err.message);
    if (win) win.webContents.send("desktop-ipc-event:auth:onLoginError", { error: err.message });
  }
}

function registerAgentStudioProtocol() {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      return app.setAsDefaultProtocolClient("agentstudio", process.execPath, [path.resolve(process.argv[1])]);
    }
    return false;
  }
  return app.setAsDefaultProtocolClient("agentstudio");
}

const ownsInstance = app.requestSingleInstanceLock();
ipcMain.handle('loam-updates', async (event, action) => {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || new URL(event.senderFrame.url).origin !== BASE) throw new Error('غير مسموح.');
  if (action === 'status') return updater.getStatus();
  if (action === 'check') { void updater.check();return updater.getStatus(); }
  if (action === 'install') { if (!await updater.installNow()) throw new Error('لم يكتمل تنزيل التحديث بعد.');return { state: 'installing' }; }
  throw new Error('إجراء غير صالح.');
});
if (!ownsInstance) app.quit();
app.on("second-instance", (_event, argv) => {
  const deepLink = findDeepLinkArg(argv);
  if (deepLink) { void handleDeepLinkCallback(deepLink); return; }
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});
app.on("open-url", (event, url) => {
  event.preventDefault();
  pendingDeepLink = url;
  if (app.isReady()) void handleDeepLinkCallback(url);
});

app.whenReady().then(async () => {
  if (!ownsInstance) return;
  prepareUserData();

  // Settings > In-App Browser (WebContentsView surface). The homepage is read
  // from the shared Loam settings the agent browser tool uses for its
  // browser_open default, so one homepage setting drives both.
  async function resolveInAppBrowserHomepage() {
    try {
      const res = await fetch(`${BASE}/api/settings`, { headers: authHeader(localAuthToken), signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const s = await res.json();
        const homepage = typeof s.browserHomepage === "string" ? s.browserHomepage.trim() : "";
        if (/^https?:\/\//i.test(homepage)) return homepage;
      }
    } catch {}
    return "";
  }
  inAppBrowser.init({
    getWindow: () => win,
    openExternal: (url) => { void shell.openExternal(url); },
    resolveHomepage: resolveInAppBrowserHomepage,
    fallbackHomepage: "https://www.google.com",
  });

  const localAuth = getLocalAuthToken();
  localAuthToken = localAuth.token;
  localAuthUserData = localAuth.userData;
  process.env.LOAM_LOCAL_TOKEN = localAuthToken;
  process.env.LOAM_LOCAL_TOKEN_DIR = localAuthUserData;
  sessionToken = readLocalStorage()["session_token"] || "";

  registerAgentStudioProtocol();

  // Serve the Next.js static export over the privileged custom app:// protocol.
  const staticRoot = path.resolve(WEB_OUT) + path.sep;
  function toSafeFile(relPath) {
    // Strip the leading slash and join under WEB_OUT so the same code works on
    // Windows, macOS and Linux (path.resolve would mis-handle "/app/..." on
    // Windows as a drive-root absolute path).
    const cleaned = relPath.replace(/^\/+/, "").split(path.sep).join(path.sep);
    const filePath = path.normalize(path.join(WEB_OUT, cleaned));
    if (!filePath.startsWith(staticRoot)) return null;
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? filePath : null;
  }
  // Next.js only pre-renders /app/demo-running and /app/demo-completed. Any
  // other /app/<id> (including its RSC payloads) should fall back to the
  // demo-running page so the client can read the real id from the URL.
  function appDynamicFallback(relPath) {
    const m = /^\/app\/([^/]+)(?:\/(.*))?$/.exec(relPath);
    if (!m) return null;
    const uid = m[1];
    if (uid === "demo-running" || uid === "demo-completed") return null;
    const rest = m[2];
    if (rest === undefined) {
      const ext = path.extname(uid).toLowerCase();
      if (ext === ".html" || ext === ".htm") return "/app/demo-running.html";
      if (ext === ".txt") return "/app/demo-running.txt";
      return "/app/demo-running";
    }
    if (rest === "") return "/app/demo-running";
    return "/app/demo-running/" + rest;
  }
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "agent") return new Response("Not Found", { status: 404 });
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";
    else if (pathname.endsWith("/")) pathname += "index.html";
    else if (!path.extname(pathname)) {
      const htmlPath = pathname + ".html";
      if (toSafeFile(htmlPath)) pathname = htmlPath;
      else pathname += "/index.html";
    }
    let filePath = toSafeFile(pathname);
    if (!filePath) {
      const fbRel = appDynamicFallback(pathname);
      if (fbRel) {
        if (!path.extname(fbRel)) {
          filePath = toSafeFile(fbRel + ".html") || toSafeFile(fbRel + "/index.html");
        } else {
          filePath = toSafeFile(fbRel) || (fbRel.endsWith("/index.html") ? toSafeFile(fbRel.replace(/\/index\.html$/, ".html")) : null);
        }
      }
    }
    if (!filePath) {
      const fallback = path.join(WEB_OUT, "404.html");
      if (fs.existsSync(fallback)) {
        return new Response(fs.readFileSync(fallback), { status: 404, headers: { "Content-Type": "text/html" } });
      }
      return new Response("Not Found", { status: 404 });
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    return new Response(fs.readFileSync(filePath), { headers: { "Content-Type": mime } });
  });

  // Serve the vendored Loam Video wasm editor over the privileged
  // loamfilm:// protocol. Files come from electron/filmcraft/dist; overlay
  // files (e.g. bridge-relay.js) may live directly in electron/filmcraft/ so
  // they survive re-copying a fresh dist folder. .wasm must be served as
  // application/wasm so the editor boots.
  const FILMCRAFT_DIST = path.join(ROOT, "electron", "filmcraft", "dist");
  const FILMCRAFT_OVERLAY = path.join(ROOT, "electron", "filmcraft");
  const FILMCRAFT_MIME = {
    ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
    ".json": "application/json", ".png": "image/png", ".wasm": "application/wasm",
  };
  function filmcraftFile(relPath) {
    const cleaned = relPath.replace(/^\/+/, "");
    for (const baseDir of [FILMCRAFT_DIST, FILMCRAFT_OVERLAY]) {
      const baseRoot = path.resolve(baseDir) + path.sep;
      const filePath = path.normalize(path.join(baseDir, cleaned));
      if (!filePath.startsWith(baseRoot)) continue;
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return filePath;
    }
    return null;
  }
  protocol.handle("loamfilm", async (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/" || pathname.endsWith("/")) pathname += "index.html";
    const filePath = filmcraftFile(pathname);
    if (!filePath) return new Response("Not Found", { status: 404 });
    const ext = path.extname(filePath).toLowerCase();
    const mime = FILMCRAFT_MIME[ext] || "application/octet-stream";
    const body = fs.readFileSync(filePath);
    if (ext === ".html") {
      // Inject the agent bridge relay into the vendored page so the host app
      // can drive window.filmcraft over postMessage without editing the
      // dist files themselves (fresh dist copies keep working).
      let html = body.toString("utf8");
      if (!html.includes("bridge-relay.js")) {
        html = /<\/head>/i.test(html)
          ? html.replace(/<\/head>/i, '<script src="bridge-relay.js"></script></head>')
          : html + '<script src="bridge-relay.js"></script>';
      }
      return new Response(html, { headers: { "Content-Type": mime } });
    }
    return new Response(body, { headers: { "Content-Type": mime } });
  });

  // Serve the vendored Loam Effects wasm engine over the privileged
  // loameffect:// protocol. Files come from electron/effectcraft/dist; overlay
  // files (e.g. bridge-relay.js) may live directly in electron/effectcraft/ so
  // they survive re-copying a fresh dist folder. .wasm must be served as
  // application/wasm so the engine boots. The page is served cross-origin
  // isolated (COOP/COEP) so the render queue can use SharedArrayBuffer in Web
  // Workers; every response also carries CORP so same-origin subresources
  // satisfy COEP.
  const EFFECTCRAFT_DIST = path.join(ROOT, "electron", "effectcraft", "dist");
  const EFFECTCRAFT_OVERLAY = path.join(ROOT, "electron", "effectcraft");
  const EFFECTCRAFT_MIME = {
    ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
    ".json": "application/json", ".png": "image/png", ".wasm": "application/wasm",
  };
  function effectcraftFile(relPath) {
    const cleaned = relPath.replace(/^\/+/, "");
    for (const baseDir of [EFFECTCRAFT_DIST, EFFECTCRAFT_OVERLAY]) {
      const baseRoot = path.resolve(baseDir) + path.sep;
      const filePath = path.normalize(path.join(baseDir, cleaned));
      if (!filePath.startsWith(baseRoot)) continue;
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return filePath;
    }
    return null;
  }
  protocol.handle("loameffect", async (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/" || pathname.endsWith("/")) pathname += "index.html";
    const filePath = effectcraftFile(pathname);
    if (!filePath) return new Response("Not Found", { status: 404 });
    const ext = path.extname(filePath).toLowerCase();
    const mime = EFFECTCRAFT_MIME[ext] || "application/octet-stream";
    const body = fs.readFileSync(filePath);
    const headers = {
      "Content-Type": mime,
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    };
    if (ext === ".html") {
      // Inject the agent bridge relay into the vendored page so the host app
      // can drive window.effectcraft over postMessage without editing the
      // dist files themselves (fresh dist copies keep working).
      let html = body.toString("utf8");
      if (!html.includes("bridge-relay.js")) {
        html = /<\/head>/i.test(html)
          ? html.replace(/<\/head>/i, '<script src="bridge-relay.js"></script></head>')
          : html + '<script src="bridge-relay.js"></script>';
      }
      return new Response(html, { headers });
    }
    return new Response(body, { headers });
  });

  // Health-check the Agent Studio backend; do not block the UI if it is down.
  try {
    const health = await fetch(AGENT_STUDIO_BACKEND + "/api/health", { signal: AbortSignal.timeout(3000) });
    if (!health.ok) console.warn("[electron] Agent Studio backend health returned " + health.status);
    else console.log("[electron] Agent Studio backend ready");
  } catch (err) {
    console.warn("[electron] Agent Studio backend not reachable at " + AGENT_STUDIO_BACKEND + "/api/health: " + err.message);
  }

  buildMenu();
  createTray();
  await mcpBridge.start(ROOT, BRIDGE_PORT);
  try {
    console.log("[electron] server mode: " + (await ensureServer()));
    loamServerReady = true;
  } catch (err) {
    console.error("[electron] Loam server unavailable: " + err.message);
    if (isAgentStudioUI()) {
      console.warn("[electron] continuing without Loam server (Agent Studio UI)");
    } else {
      dialog.showErrorBox("Loam — تعذّر بدء التشغيل", err.message);
      app.quit();
      return;
    }
  }
  createWindow();
  if (loamServerReady && win) {
    // Inject the install token into all renderer requests to the local API.
    const filter = { urls: [`${BASE}/api/*`] };
    win.webContents.session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      details.requestHeaders["x-loam-local-token"] = localAuthToken;
      callback({ requestHeaders: details.requestHeaders });
    });
  }
  if (loamServerReady) startServerWatchdog();
  if (loamServerReady) {
    const localUpdates = await require("./local-updates.cjs").startLocalUpdates(path.join(app.getPath("userData"), "updates"));
    updater.init({
      localFeed: localUpdates.url,
      canInstall: async () => {
        const response = await fetch(BASE + "/api/tasks", { headers: authHeader(localAuthToken), signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error("تعذّر التحقق من المهام الجارية. أعد المحاولة.");
        const data = await response.json();
        return !data.tasks.some(task => ["running", "queued", "pending"].includes(task.status));
      },
      onStatus: (s) => {
        const label = s && s.state === "downloaded" ? "تحديث جاهز" : s && s.state ? s.state : "idle";
        if (tray) tray.setToolTip("Loam — " + label);
        // Push status to the Agent Studio UI (preload exposes
        // desktopEvents.updater.onStatusChanged for this channel).
        try { win?.webContents.send("desktop-ipc-event:updater:onStatusChanged", s); } catch {}
      },
    });
  }

  // Handle any deep link passed at startup or queued before the app was ready.
  const startupDeepLink = pendingDeepLink ?? findDeepLinkArg(process.argv);
  if (startupDeepLink) void handleDeepLinkCallback(startupDeepLink);
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
